import { randomUUID } from "node:crypto";
import { canonicalHash, canonicalStringify, sha256Hex } from "../domain/canonical";
import {
  asId,
  type Actor,
  type ActorKind,
  type AuditedToolProposal,
  type AuditEvent,
  type AuditPayloads,
  type AuditEventType,
  type Clock,
  type ConversationId,
  type DraftAuditEvent,
  type EventId,
  type MessageId,
  type PolicyDecision,
  type PreparedToolProposal,
  type ProposalId,
  type ProviderId,
  type ProviderChunk,
  type ProviderCapability,
  type ProviderRequestId,
  type ProviderSelection,
  type RuntimeBudget,
  type TurnId,
  type WorkspaceId,
  systemClock,
} from "../domain/contracts";
import {
  ApprovalRejectedError,
  MAX_APPROVAL_LIFETIME_MS,
  proposalFingerprint,
  type PolicyContext,
} from "../policy/toolPolicy";
import { ProviderAdapterError } from "../providers/providerAdapterCommon";
import { ProviderHistoryValidationError } from "../providers/providerHistory";
import { ProviderStreamBoundaryError } from "../providers/providerStream";
import { ReviewedToolError } from "../providers/reviewedTools";
import {
  ProviderPreflightError,
  ProviderRouter,
  ProviderTransportError,
  ProviderTurnCancelledError,
} from "../providers/providerRouter";
import {
  addNativeAbortListener,
  isNativeAbortSignal,
  isAuthenticCredentialBrokerError,
  nativeSignalAborted,
  removeNativeAbortListener,
} from "../providers/credentialBroker";
import { DurableJournal, JournalCommitGuardError } from "../storage/durableJournal";
import {
  ExecutionOutcomeUnknownError,
  ToolExecutionBlockedError,
  ToolPreparationError,
  type AuthenticatedHumanApprover,
  type UniversalToolGateway,
} from "../tools/universalToolGateway";
import {
  assistantTextForTurn,
  findExistingTurn,
  projectConversation,
  projectProviderHistory,
  ProviderHistoryError,
} from "./conversationProjection";

export class BudgetExceededError extends Error {
  constructor(readonly reasonCode: "step_budget" | "cost_budget" | "time_budget") {
    super(`Turn stopped before exceeding its ${reasonCode}.`);
    this.name = "BudgetExceededError";
  }
}

export interface TrustedCostAccountingPort {
  costForProviderChunk(input: {
    readonly providerId: ProviderId;
    readonly modelId: string;
    readonly providerRequestId: ProviderRequestId;
    readonly chunkKind: ProviderChunk["kind"];
  }): number;
}

export const MAX_COORDINATOR_CACHE_ENTRIES = 1_024;

export class RuntimeCapacityError extends Error {
  readonly reasonCode = "runtime_capacity";

  constructor() {
    super("Runtime live-state capacity was reached.");
    this.name = "RuntimeCapacityError";
    Object.freeze(this);
  }
}

export function setBoundedCacheEntry<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maximum = MAX_COORDINATOR_CACHE_ENTRIES,
): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_COORDINATOR_CACHE_ENTRIES) {
    throw new Error("Runtime cache maximum is invalid");
  }
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function setLiveStateEntry<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maximum = MAX_COORDINATOR_CACHE_ENTRIES,
): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_COORDINATOR_CACHE_ENTRIES) {
    throw new RuntimeCapacityError();
  }
  if (!map.has(key) && map.size >= maximum) throw new RuntimeCapacityError();
  map.set(key, value);
}

const BUDGET_FAILURE_CODES = new Set(["step_budget", "cost_budget", "time_budget"]);
const PREFLIGHT_FAILURE_CODES = new Set([
  "empty_selection", "unknown_capability", "duplicate_candidate", "unknown_provider", "unknown_model",
  "ineligible_primary", "ineligible_candidate", "duplicate_provider", "invalid_capability_document",
  "invalid_credential_binding", "invalid_reviewed_tools", "authority_changed",
]);
const TRANSPORT_FAILURE_CODES = new Set([
  "connect_failure_before_body", "http_retryable_before_stream", "outcome_unknown",
]);
const ADAPTER_FAILURE_CODES = new Set([
  "invalid_adapter_configuration", "invalid_turn_request", "unsupported_model", "protocol_violation",
  "malformed_order", "duplicate_identity", "unknown_authority_event", "provider_error",
  "incomplete_response", "refusal", "multiple_tool_calls", "reasoning_round_trip_unavailable",
  "secret_reflection_blocked",
]);
const STREAM_FAILURE_CODES = new Set([
  "invalid_limits", "invalid_request_id", "event_line_too_large", "event_too_large", "response_too_large",
  "text_too_large", "too_many_events", "duration_exceeded", "idle_timeout", "malformed_sse",
  "malformed_utf8", "utf8_bom_forbidden", "malformed_json", "duplicate_json_key", "json_depth_exceeded",
  "request_cancelled", "upstream_stream_failure", "cleanup_failed", "secret_reflection_blocked",
  "tool_arguments_too_large", "tool_arguments_malformed", "invalid_provider_id", "invalid_usage",
]);
const PROJECTED_HISTORY_FAILURE_CODES = new Set([
  "empty_provider_history", "invalid_provider_history", "duplicate_provider_history_id",
  "broken_provider_history_alternation", "incomplete_durable_tool_history",
]);
const PROVIDER_HISTORY_FAILURE_CODES = new Set([
  "empty_history", "invalid_history_record", "duplicate_history_id", "broken_history_alternation",
  "incomplete_tool_exchange", "cross_provider_tool_exchange", "history_too_large",
]);
const REVIEWED_TOOL_FAILURE_CODES = new Set([
  "invalid_tool_definition", "tool_name_collision", "schema_hash_mismatch", "unsupported_schema",
  "invalid_tool_arguments", "unadvertised_tool",
]);
const TOOL_PREPARATION_FAILURE_CODES = new Set(["tool_unknown", "manifest_incomplete", "proposal_forged"]);
const TOOL_EXECUTION_FAILURE_CODES = new Set([
  "terminal_attempt_requires_reconciliation", "cannot_deny_started", "cannot_deny_succeeded",
  "cannot_deny_outcome_unknown", "cannot_deny_denied", "already_succeeded", "reconciliation_required",
  "already_in_progress", "human_denied", "manifest_incomplete", "effect_unknown",
  "pure_manifest_has_scope", "effect_unclassified", "turn_or_direction_retired", "authority_cache_capacity",
]);
const APPROVAL_FAILURE_CODES = new Set([
  "approval_not_applicable", "invalid_approval_lifetime", "grant_unknown", "grant_tampered", "grant_replayed",
  "grant_expired", "approver_not_authenticated_human", "proposal_mismatch", "actor_mismatch",
  "workspace_mismatch", "conversation_mismatch", "turn_mismatch", "direction_epoch_mismatch", "tool_mismatch",
  "schema_mismatch", "arguments_mismatch", "scope_mismatch", "policy_mismatch", "policy_no_longer_asks",
]);

function allowlistedFailureReason(error: unknown, allowed: ReadonlySet<string>): string | undefined {
  try {
    const reason = (error as { readonly reasonCode?: unknown }).reasonCode;
    return typeof reason === "string" && allowed.has(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

function safeTurnFailureCode(error: unknown): string {
  if (error instanceof RuntimeCapacityError) return "runtime_capacity";
  if (error instanceof BudgetExceededError) {
    return allowlistedFailureReason(error, BUDGET_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ProviderPreflightError) {
    return allowlistedFailureReason(error, PREFLIGHT_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ProviderTransportError) {
    return allowlistedFailureReason(error, TRANSPORT_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ProviderAdapterError) {
    return allowlistedFailureReason(error, ADAPTER_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ProviderStreamBoundaryError) {
    return allowlistedFailureReason(error, STREAM_FAILURE_CODES) ?? "unknown_failure";
  }
  if (isAuthenticCredentialBrokerError(error)) return error.reasonCode;
  if (error instanceof ProviderHistoryError) {
    return allowlistedFailureReason(error, PROJECTED_HISTORY_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ProviderHistoryValidationError) {
    return allowlistedFailureReason(error, PROVIDER_HISTORY_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ReviewedToolError) {
    return allowlistedFailureReason(error, REVIEWED_TOOL_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ToolPreparationError) {
    return allowlistedFailureReason(error, TOOL_PREPARATION_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ToolExecutionBlockedError) {
    return allowlistedFailureReason(error, TOOL_EXECUTION_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ApprovalRejectedError) {
    return allowlistedFailureReason(error, APPROVAL_FAILURE_CODES) ?? "unknown_failure";
  }
  if (error instanceof ExecutionOutcomeUnknownError) return "execution_outcome_unknown";
  return "unknown_failure";
}

export interface SendMessageInput {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly clientRequestId: string;
  readonly content: string;
  readonly user: Actor;
  readonly proposingAgent: Actor;
  readonly provider: ProviderSelection;
  readonly budget: RuntimeBudget;
  readonly policyContext: PolicyContext;
  readonly signal?: AbortSignal;
}

export interface ProposalDecisionInput {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly clientRequestId: string;
  readonly turnId: TurnId;
  readonly proposalId: ProposalId;
  readonly disposition: "approve" | "deny";
  readonly approver?: AuthenticatedHumanApprover;
  readonly provider: ProviderSelection;
  readonly budget: RuntimeBudget;
  readonly policyContext: PolicyContext;
  readonly signal?: AbortSignal;
}

export interface StopTurnInput {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly clientRequestId: string;
  readonly turnId: TurnId;
  readonly directionEpoch: number;
  readonly human: Actor;
}

export interface SteerTurnInput extends StopTurnInput {
  readonly content: string;
}

export interface FollowUpSteerInput {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly clientRequestId: string;
  readonly content: string;
  readonly human: Actor;
  readonly proposingAgent: Actor;
  readonly provider: ProviderSelection;
  readonly budget: RuntimeBudget;
  readonly policyContext: PolicyContext;
  readonly signal?: AbortSignal;
  readonly turnId?: undefined;
  readonly directionEpoch?: undefined;
}

export type SteerOrFollowUpInput = SteerTurnInput | FollowUpSteerInput;

export class StaleTurnControlError extends Error {
  constructor(readonly reasonCode: "stale_turn_or_epoch" | "control_request_conflict") {
    super(`Turn control was rejected (${reasonCode}).`);
    this.name = "StaleTurnControlError";
  }
}

export class SendRequestConflictError extends Error {
  constructor(readonly reasonCode = "client_request_conflict") {
    super(`Message request was rejected (${reasonCode}).`);
    this.name = "SendRequestConflictError";
  }
}

class DirectionEpochRetiredError extends Error {
  constructor(
    readonly turnId: TurnId,
    readonly directionEpoch: number,
  ) {
    super(`Direction epoch ${directionEpoch} for turn ${turnId} is retired.`);
    this.name = "DirectionEpochRetiredError";
  }
}

export type TurnResult =
  | {
      readonly status: "completed";
      readonly turnId: TurnId;
      readonly assistantText: string;
      readonly steps: number;
      readonly costUnits: number;
    }
  | {
      readonly status: "paused";
      readonly turnId: TurnId;
      readonly proposal: AuditedToolProposal;
      readonly decision: PolicyDecision;
      readonly steps: number;
      readonly costUnits: number;
    }
  | {
      readonly status: "cancelled" | "failed" | "denied" | "interrupted" | "stopped";
      readonly turnId: TurnId;
      readonly reasonCode: string;
      readonly steps: number;
      readonly costUnits: number;
    };

interface PhaseCompleted {
  readonly kind: "completed";
  readonly text: string;
}

interface PhasePaused {
  readonly kind: "paused";
  readonly proposal: PreparedToolProposal;
  readonly decision: PolicyDecision;
}

interface PhaseContinues {
  readonly kind: "continue";
}

type PhaseResult = PhaseCompleted | PhasePaused | PhaseContinues;

interface PendingProposalAuthority {
  readonly proposal: PreparedToolProposal;
  readonly budget: RuntimeBudget;
  readonly provider: ProviderSelection;
  readonly providerPlanSignature: string;
}

const RUNTIME_IDENTIFIER_MAXIMUM = 160;
const RUNTIME_CLIENT_REQUEST_ID_MAXIMUM = 200;
const RUNTIME_ACTOR_LABEL_MAXIMUM = 80;
const RUNTIME_CONTENT_MAXIMUM = 8_000;
const RUNTIME_SCOPE_MAXIMUM = 512;
const RUNTIME_SCOPE_COUNT_MAXIMUM = 1_024;
const RUNTIME_PROVIDER_CANDIDATE_MAXIMUM = 32;
const RUNTIME_IDENTIFIER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const RUNTIME_PROVIDER_CAPABILITIES = new Set<ProviderCapability>([
  "streaming",
  "tool_proposals",
  "image_input",
  "usage",
  "cancellation",
  "opaque_reasoning_round_trip",
]);
const RUNTIME_ACTOR_KINDS = new Set<ActorKind>([
  "human", "agent", "system", "provider", "tool",
]);

export class RuntimeCommandValidationError extends Error {
  readonly reasonCode = "invalid_runtime_command";

  constructor(readonly field: string) {
    super(field === "content"
      ? "Runtime command admission rejected: content must contain between 1 and 8000 characters."
      : field.startsWith("budget.")
        ? "Runtime budgets must be finite and positive (cost may be zero)."
        : `Runtime command admission rejected (${field}).`);
    this.name = "RuntimeCommandValidationError";
    Object.freeze(this);
  }
}

interface CapturedRuntimeRecord {
  readonly values: Readonly<Record<string, unknown>>;
  readonly keys: ReadonlySet<string>;
}

function invalidRuntimeCommand(field: string): never {
  throw new RuntimeCommandValidationError(field);
}

function captureRuntimeRecord(value: unknown, field: string): CapturedRuntimeRecord {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidRuntimeCommand(field);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidRuntimeCommand(field);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return invalidRuntimeCommand(field);
    const keys = ownKeys as string[];
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return invalidRuntimeCommand(field);
      }
      values[key] = descriptor.value;
    }
    return Object.freeze({
      values: Object.freeze(values),
      keys: new Set(keys),
    });
  } catch {
    return invalidRuntimeCommand(field);
  }
}

function assertRuntimeKeys(
  record: CapturedRuntimeRecord,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !record.keys.has(key)) ||
    [...record.keys].some((key) => !allowed.has(key))
  ) {
    invalidRuntimeCommand(field);
  }
}

function captureRuntimeArray(
  value: unknown,
  field: string,
  maximum: number,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return invalidRuntimeCommand(field);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors["length"];
    if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum) {
      return invalidRuntimeCommand(field);
    }
    const length = Number(lengthDescriptor.value);
    const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      return invalidRuntimeCommand(field);
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return invalidRuntimeCommand(field);
      }
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return invalidRuntimeCommand(field);
  }
}

function captureRuntimeIdentifier(
  value: unknown,
  field: string,
  maximum = RUNTIME_IDENTIFIER_MAXIMUM,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    RUNTIME_IDENTIFIER_CONTROL_PATTERN.test(value)
  ) {
    return invalidRuntimeCommand(field);
  }
  return value;
}

function captureRuntimeContent(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > RUNTIME_CONTENT_MAXIMUM
  ) {
    return invalidRuntimeCommand(field);
  }
  return value;
}

function captureRuntimeActor(
  value: unknown,
  expectedKind: ActorKind | undefined,
  field: string,
): Actor {
  const record = captureRuntimeRecord(value, field);
  assertRuntimeKeys(record, ["kind", "id"], ["label"], field);
  if (typeof record.values.kind !== "string" ||
    !RUNTIME_ACTOR_KINDS.has(record.values.kind as ActorKind) ||
    (expectedKind !== undefined && record.values.kind !== expectedKind)) {
    return invalidRuntimeCommand(`${field}.kind`);
  }
  const kind = record.values.kind as ActorKind;
  const id = captureRuntimeIdentifier(record.values.id, `${field}.id`);
  let label: string | undefined;
  if (record.keys.has("label") && record.values.label !== undefined) {
    label = captureRuntimeIdentifier(
      record.values.label,
      `${field}.label`,
      RUNTIME_ACTOR_LABEL_MAXIMUM,
    );
  }
  return Object.freeze({ kind, id, ...(label === undefined ? {} : { label }) });
}

function frozenProviderSelection(value: unknown, field = "provider"): ProviderSelection {
  const record = captureRuntimeRecord(value, field);
  assertRuntimeKeys(record, ["candidates", "requiredCapabilities"], [], field);
  const rawCandidates = captureRuntimeArray(
    record.values.candidates,
    `${field}.candidates`,
    RUNTIME_PROVIDER_CANDIDATE_MAXIMUM,
  );
  if (rawCandidates.length === 0) return invalidRuntimeCommand(`${field}.candidates`);
  const candidates = rawCandidates.map((candidate, index) => {
    const candidateRecord = captureRuntimeRecord(candidate, `${field}.candidates[${index}]`);
    assertRuntimeKeys(
      candidateRecord,
      ["providerId", "modelId"],
      [],
      `${field}.candidates[${index}]`,
    );
    return Object.freeze({
      providerId: captureRuntimeIdentifier(
        candidateRecord.values.providerId,
        `${field}.candidates[${index}].providerId`,
      ) as ProviderId,
      modelId: captureRuntimeIdentifier(
        candidateRecord.values.modelId,
        `${field}.candidates[${index}].modelId`,
      ),
    });
  });
  const rawCapabilities = captureRuntimeArray(
    record.values.requiredCapabilities,
    `${field}.requiredCapabilities`,
    RUNTIME_PROVIDER_CAPABILITIES.size,
  );
  const requiredCapabilities = rawCapabilities.map((capability, index) => {
    if (typeof capability !== "string" ||
      !RUNTIME_PROVIDER_CAPABILITIES.has(capability as ProviderCapability)) {
      return invalidRuntimeCommand(`${field}.requiredCapabilities[${index}]`);
    }
    return capability as ProviderCapability;
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    requiredCapabilities: Object.freeze(requiredCapabilities),
  });
}

function captureRuntimeBudget(value: unknown, field = "budget"): RuntimeBudget {
  const record = captureRuntimeRecord(value, field);
  assertRuntimeKeys(record, ["maxSteps", "maxCostUnits", "maxDurationMs"], [], field);
  const { maxSteps, maxCostUnits, maxDurationMs } = record.values;
  if (!Number.isSafeInteger(maxSteps) || Number(maxSteps) < 1) {
    return invalidRuntimeCommand(`${field}.maxSteps`);
  }
  if (typeof maxCostUnits !== "number" || !Number.isFinite(maxCostUnits) || maxCostUnits < 0) {
    return invalidRuntimeCommand(`${field}.maxCostUnits`);
  }
  if (typeof maxDurationMs !== "number" || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    return invalidRuntimeCommand(`${field}.maxDurationMs`);
  }
  return Object.freeze({ maxSteps: Number(maxSteps), maxCostUnits, maxDurationMs });
}

function captureRuntimePolicyContext(value: unknown, field = "policyContext"): PolicyContext {
  const record = captureRuntimeRecord(value, field);
  assertRuntimeKeys(record, ["grantedDataScopes", "grantedNetworkScopes"], [], field);
  const captureScopes = (raw: unknown, scopeField: string): readonly string[] =>
    Object.freeze(captureRuntimeArray(raw, scopeField, RUNTIME_SCOPE_COUNT_MAXIMUM).map((scope, index) =>
      captureRuntimeIdentifier(scope, `${scopeField}[${index}]`, RUNTIME_SCOPE_MAXIMUM)
    ));
  return Object.freeze({
    grantedDataScopes: captureScopes(record.values.grantedDataScopes, `${field}.grantedDataScopes`),
    grantedNetworkScopes: captureScopes(record.values.grantedNetworkScopes, `${field}.grantedNetworkScopes`),
  });
}

function captureRuntimeSignal(value: unknown, present: boolean, field = "signal"): AbortSignal | undefined {
  if (!present || value === undefined) return undefined;
  if (!isNativeAbortSignal(value)) return invalidRuntimeCommand(field);
  return value;
}

function captureRuntimeApprover(value: unknown, field = "approver"): AuthenticatedHumanApprover {
  const record = captureRuntimeRecord(value, field);
  assertRuntimeKeys(record, ["principalId", "kind", "assurance"], [], field);
  if (record.values.kind !== "human") return invalidRuntimeCommand(`${field}.kind`);
  if (record.values.assurance !== "authenticated_control_plane") {
    return invalidRuntimeCommand(`${field}.assurance`);
  }
  return Object.freeze({
    principalId: captureRuntimeIdentifier(record.values.principalId, `${field}.principalId`),
    kind: "human",
    assurance: "authenticated_control_plane",
  });
}

function snapshotSendMessageInput(value: unknown): SendMessageInput {
  const record = captureRuntimeRecord(value, "sendMessage");
  assertRuntimeKeys(record, [
    "workspaceId", "conversationId", "clientRequestId", "content", "user", "proposingAgent",
    "provider", "budget", "policyContext",
  ], ["signal"], "sendMessage");
  const signal = captureRuntimeSignal(record.values.signal, record.keys.has("signal"));
  return Object.freeze({
    workspaceId: captureRuntimeIdentifier(record.values.workspaceId, "workspaceId") as WorkspaceId,
    conversationId: captureRuntimeIdentifier(record.values.conversationId, "conversationId") as ConversationId,
    clientRequestId: captureRuntimeIdentifier(
      record.values.clientRequestId,
      "clientRequestId",
      RUNTIME_CLIENT_REQUEST_ID_MAXIMUM,
    ),
    content: captureRuntimeContent(record.values.content, "content"),
    user: captureRuntimeActor(record.values.user, "human", "user"),
    proposingAgent: captureRuntimeActor(record.values.proposingAgent, "agent", "proposingAgent"),
    provider: frozenProviderSelection(record.values.provider),
    budget: captureRuntimeBudget(record.values.budget),
    policyContext: captureRuntimePolicyContext(record.values.policyContext),
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotProposalDecisionInput(value: unknown): ProposalDecisionInput {
  const record = captureRuntimeRecord(value, "proposalDecision");
  assertRuntimeKeys(record, [
    "workspaceId", "conversationId", "clientRequestId", "turnId", "proposalId", "disposition",
    "provider", "budget", "policyContext",
  ], ["approver", "signal"], "proposalDecision");
  if (record.values.disposition !== "approve" && record.values.disposition !== "deny") {
    return invalidRuntimeCommand("disposition");
  }
  const approver = record.keys.has("approver") && record.values.approver !== undefined
    ? captureRuntimeApprover(record.values.approver)
    : undefined;
  if (record.values.disposition === "approve" && !approver) {
    return invalidRuntimeCommand("approver");
  }
  const signal = captureRuntimeSignal(record.values.signal, record.keys.has("signal"));
  return Object.freeze({
    workspaceId: captureRuntimeIdentifier(record.values.workspaceId, "workspaceId") as WorkspaceId,
    conversationId: captureRuntimeIdentifier(record.values.conversationId, "conversationId") as ConversationId,
    clientRequestId: captureRuntimeIdentifier(
      record.values.clientRequestId,
      "clientRequestId",
      RUNTIME_CLIENT_REQUEST_ID_MAXIMUM,
    ),
    turnId: captureRuntimeIdentifier(record.values.turnId, "turnId") as TurnId,
    proposalId: captureRuntimeIdentifier(record.values.proposalId, "proposalId") as ProposalId,
    disposition: record.values.disposition,
    ...(approver === undefined ? {} : { approver }),
    provider: frozenProviderSelection(record.values.provider),
    budget: captureRuntimeBudget(record.values.budget),
    policyContext: captureRuntimePolicyContext(record.values.policyContext),
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotStopTurnInput(value: unknown): StopTurnInput {
  const record = captureRuntimeRecord(value, "stopTurn");
  assertRuntimeKeys(record, [
    "workspaceId", "conversationId", "clientRequestId", "turnId", "directionEpoch", "human",
  ], [], "stopTurn");
  if (!Number.isSafeInteger(record.values.directionEpoch) || Number(record.values.directionEpoch) < 1) {
    return invalidRuntimeCommand("directionEpoch");
  }
  return Object.freeze({
    workspaceId: captureRuntimeIdentifier(record.values.workspaceId, "workspaceId") as WorkspaceId,
    conversationId: captureRuntimeIdentifier(record.values.conversationId, "conversationId") as ConversationId,
    clientRequestId: captureRuntimeIdentifier(
      record.values.clientRequestId,
      "clientRequestId",
      RUNTIME_CLIENT_REQUEST_ID_MAXIMUM,
    ),
    turnId: captureRuntimeIdentifier(record.values.turnId, "turnId") as TurnId,
    directionEpoch: Number(record.values.directionEpoch),
    human: captureRuntimeActor(record.values.human, "human", "human"),
  });
}

function snapshotSteerOrFollowUpInput(value: unknown): SteerOrFollowUpInput {
  const record = captureRuntimeRecord(value, "steerTurn");
  const turnIdIsDefined = record.values.turnId !== undefined;
  const directionEpochIsDefined = record.values.directionEpoch !== undefined;
  if (turnIdIsDefined !== directionEpochIsDefined) {
    return invalidRuntimeCommand("steerTarget");
  }
  if (turnIdIsDefined && directionEpochIsDefined) {
    assertRuntimeKeys(record, [
      "workspaceId", "conversationId", "clientRequestId", "turnId", "directionEpoch", "human", "content",
    ], [], "steerTurn");
    const stopped = snapshotStopTurnInput(Object.freeze({
      workspaceId: record.values.workspaceId,
      conversationId: record.values.conversationId,
      clientRequestId: record.values.clientRequestId,
      turnId: record.values.turnId,
      directionEpoch: record.values.directionEpoch,
      human: record.values.human,
    }));
    return Object.freeze({ ...stopped, content: captureRuntimeContent(record.values.content, "content") });
  }
  assertRuntimeKeys(record, [
    "workspaceId", "conversationId", "clientRequestId", "content", "human", "proposingAgent",
    "provider", "budget", "policyContext",
  ], ["signal", "turnId", "directionEpoch"], "followUpSteer");
  const signal = captureRuntimeSignal(record.values.signal, record.keys.has("signal"));
  return Object.freeze({
    workspaceId: captureRuntimeIdentifier(record.values.workspaceId, "workspaceId") as WorkspaceId,
    conversationId: captureRuntimeIdentifier(record.values.conversationId, "conversationId") as ConversationId,
    clientRequestId: captureRuntimeIdentifier(
      record.values.clientRequestId,
      "clientRequestId",
      RUNTIME_CLIENT_REQUEST_ID_MAXIMUM,
    ),
    content: captureRuntimeContent(record.values.content, "content"),
    human: captureRuntimeActor(record.values.human, "human", "human"),
    proposingAgent: captureRuntimeActor(record.values.proposingAgent, "agent", "proposingAgent"),
    provider: frozenProviderSelection(record.values.provider),
    budget: captureRuntimeBudget(record.values.budget),
    policyContext: captureRuntimePolicyContext(record.values.policyContext),
    ...(signal === undefined ? {} : { signal }),
  });
}

interface ActiveTurnState {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly clientRequestId: string;
  readonly proposingAgent: Actor;
  readonly provider: ProviderSelection;
  readonly budget: RuntimeBudget;
  readonly policyContext: PolicyContext;
  readonly providerPlanSignature: string;
  readonly tracker: BudgetTracker;
  readonly externalSignal?: AbortSignal;
  directionEpoch: number;
  controller: AbortController;
  mode: "active" | "retiring" | "finishing";
  providerCommitInProgress: boolean;
  providerCommitPointReached: boolean;
  pendingAbortReason?: Error;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class BudgetTracker {
  steps: number;
  costUnits: number;
  private readonly budget: RuntimeBudget;

  constructor(
    budget: RuntimeBudget,
    private readonly clock: Clock,
    private readonly startedAt: number,
    initialSteps = 0,
    initialCostUnits = 0,
  ) {
    if (
      !Number.isSafeInteger(budget.maxSteps) ||
      budget.maxSteps < 1 ||
      !Number.isFinite(budget.maxCostUnits) ||
      budget.maxCostUnits < 0 ||
      !Number.isFinite(budget.maxDurationMs) ||
      budget.maxDurationMs <= 0
    ) {
      throw new Error("Runtime budgets must be finite and positive (cost may be zero).");
    }
    this.budget = Object.freeze({ ...budget });
    this.steps = initialSteps;
    this.costUnits = initialCostUnits;
  }

  commit(steps: number, costUnits: number): void {
    this.steps += steps;
    this.costUnits += costUnits;
  }

  assertCanConsume(steps: number, costUnits: number): void {
    this.checkTime();
    if (this.steps + steps > this.budget.maxSteps) throw new BudgetExceededError("step_budget");
    if (this.costUnits + costUnits > this.budget.maxCostUnits) {
      throw new BudgetExceededError("cost_budget");
    }
  }

  checkTime(): void {
    if (this.clock.now().getTime() - this.startedAt >= this.budget.maxDurationMs) {
      throw new BudgetExceededError("time_budget");
    }
  }

  budgetSnapshot(): RuntimeBudget {
    return this.budget;
  }

  remainingDurationMs(): number {
    return Math.max(0, this.budget.maxDurationMs - (this.clock.now().getTime() - this.startedAt));
  }
}

export class RuntimeCoordinator {
  private readonly inFlightRequests = new Map<
    string,
    { readonly signature: string; readonly operation: Promise<TurnResult> }
  >();
  private readonly completedRequests = new Map<
    string,
    { readonly signature: string; readonly result: TurnResult }
  >();
  private readonly activeTurns = new Map<TurnId, ActiveTurnState>();
  private readonly retiredEpochResults = new Map<string, Promise<TurnResult>>();
  private readonly controlOperations = new Map<
    string,
    { readonly signature: string; readonly operation: Promise<TurnResult> }
  >();
  private readonly completedControlOperations = new Map<
    string,
    { readonly signature: string; readonly result: TurnResult }
  >();
  private readonly pendingProposals = new Map<ProposalId, PendingProposalAuthority>();
  private readonly pendingProposalReservations = new Set<ProposalId>();
  private activeTurnReservations = 0;
  private readonly controllerCleanups = new WeakMap<AbortController, () => void>();

  cacheSizes(): Readonly<Record<string, number>> {
    this.pruneInvalidPendingProposals();
    return Object.freeze({
      completedRequests: this.completedRequests.size,
      controlOperations: this.controlOperations.size,
      completedControlOperations: this.completedControlOperations.size,
      retiredEpochResults: this.retiredEpochResults.size,
      pendingProposals: this.pendingProposals.size,
      activeTurnReservations: this.activeTurnReservations,
    });
  }

  constructor(
    private readonly journal: DurableJournal,
    private readonly providers: ProviderRouter,
    private readonly tools: UniversalToolGateway,
    private readonly costAccounting: TrustedCostAccountingPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async createWorkspace(workspaceId: WorkspaceId, name: string, actor: Actor): Promise<void> {
    const acceptedWorkspaceId = captureRuntimeIdentifier(workspaceId, "workspaceId") as WorkspaceId;
    const acceptedName = captureRuntimeContent(name, "workspaceName");
    const acceptedActor = captureRuntimeActor(actor, undefined, "actor");
    await this.journal.append(
      this.event(acceptedWorkspaceId, undefined, acceptedActor, "workspace.created", {
        name: acceptedName,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  async createConversation(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    title: string,
    actor: Actor,
  ): Promise<void> {
    const acceptedWorkspaceId = captureRuntimeIdentifier(workspaceId, "workspaceId") as WorkspaceId;
    const acceptedConversationId = captureRuntimeIdentifier(conversationId, "conversationId") as ConversationId;
    const acceptedTitle = captureRuntimeContent(title, "conversationTitle");
    const acceptedActor = captureRuntimeActor(actor, undefined, "actor");
    await this.journal.append(
      this.event(acceptedWorkspaceId, acceptedConversationId, acceptedActor, "conversation.created", {
        title: acceptedTitle,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  async sendMessage(input: SendMessageInput): Promise<TurnResult> {
    return this.startMessage(input, "initial");
  }

  private startMessage(input: SendMessageInput, directionKind: "initial" | "follow_up"): Promise<TurnResult> {
    input = snapshotSendMessageInput(input);
    if (!input.clientRequestId.trim()) throw new Error("clientRequestId must not be empty");
    if (input.user.kind !== "human") throw new Error("Only a human actor may submit a user message");
    if (input.proposingAgent.kind !== "agent") throw new Error("A proposing agent is required");
    this.pruneInvalidPendingProposals();

    const key = this.requestKey(input.workspaceId, input.conversationId, input.clientRequestId);
    const acceptedProvider = input.provider;
    const acceptedInput = input;
    const providerPlanSignature = this.providers.signatureFor(acceptedProvider);
    const signature = this.sendRequestHash(acceptedInput, directionKind, providerPlanSignature);
    if (this.controlOperations.has(key)) throw new SendRequestConflictError();
    if (this.journal.snapshot().some((event) =>
      event.workspaceId === input.workspaceId &&
      event.conversationId === input.conversationId &&
      event.type === "human.control.requested" &&
      (event.payload as AuditPayloads["human.control.requested"]).clientRequestId === input.clientRequestId
    )) {
      throw new SendRequestConflictError();
    }
    const completed = this.completedRequests.get(key);
    if (completed) {
      if (completed.signature !== signature) throw new SendRequestConflictError();
      if (completed.result.status !== "paused" || this.completedResultIsLivePaused(completed.result)) {
        return Promise.resolve(completed.result);
      }
      this.completedRequests.delete(key);
    }
    const pending = this.inFlightRequests.get(key);
    if (pending) {
      if (pending.signature !== signature) throw new SendRequestConflictError();
      return pending.operation;
    }
    const existing = findExistingTurn(this.journal.snapshot(), input.conversationId, input.clientRequestId);
    if (existing) {
      const durableSignature = this.durableSendRequestHash(
        input.workspaceId,
        input.conversationId,
        existing.turnId,
        input.clientRequestId,
      );
      if (!durableSignature) {
        if (existing.status === "interrupted") {
          return Promise.resolve(this.replayResult(existing));
        }
        return Promise.resolve({
          status: "interrupted",
          turnId: existing.turnId,
          reasonCode: "existing_request_signature_unavailable",
          steps: 0,
          costUnits: 0,
        });
      }
      if (durableSignature !== signature) throw new SendRequestConflictError();
      return Promise.resolve(this.replayResult(existing));
    }

    if (this.inFlightRequests.size >= MAX_COORDINATOR_CACHE_ENTRIES) {
      throw new RuntimeCapacityError();
    }
    const releaseActiveTurnReservation = this.reserveActiveTurnSlot();
    const operation = this.performSend(
      acceptedInput,
      directionKind,
      signature,
      providerPlanSignature,
      releaseActiveTurnReservation,
    )
      .then((result) => {
        this.storeCompletedRequest(key, { signature, result });
        return result;
      })
      .finally(() => {
        releaseActiveTurnReservation();
        this.inFlightRequests.delete(key);
      });
    setLiveStateEntry(this.inFlightRequests, key, { signature, operation });
    return operation;
  }

  async decideProposal(input: ProposalDecisionInput): Promise<TurnResult> {
    input = snapshotProposalDecisionInput(input);
    const pendingAuthority = this.pendingProposals.get(input.proposalId);
    const proposal = pendingAuthority?.proposal;
    if (!proposal || proposal.turnId !== input.turnId) {
      throw new Error("No live prepared effect matches this proposal decision");
    }
    if (
      proposal.workspaceId !== input.workspaceId ||
      proposal.conversationId !== input.conversationId
    ) {
      throw new Error("Proposal does not belong to the requested workspace and conversation");
    }
    if (!this.proposalIsDurablyPaused(proposal)) {
      this.pendingProposals.delete(proposal.proposalId);
      throw new StaleTurnControlError("stale_turn_or_epoch");
    }
    if (!this.pendingProviderAuthorityIsCurrent(pendingAuthority)) {
      this.pendingProposals.delete(proposal.proposalId);
      throw new ProviderPreflightError("authority_changed");
    }
    const proposalEpoch = proposal.directionEpoch ?? 1;
    if (
      proposalEpoch !== this.latestDirectionEpoch(input.workspaceId, input.conversationId, proposal.turnId) ||
      this.directionEpochIsRetired(
        input.workspaceId,
        input.conversationId,
        proposal.turnId,
        proposalEpoch,
      )
    ) {
      this.pendingProposals.delete(proposal.proposalId);
      throw new StaleTurnControlError("stale_turn_or_epoch");
    }
    const directionEpoch = proposalEpoch;
    const decisionProvider = input.provider;
    const providerPlanSignature = this.providers.signatureFor(decisionProvider);
    if (
      providerPlanSignature !== pendingAuthority.providerPlanSignature ||
      input.budget.maxSteps > pendingAuthority.budget.maxSteps ||
      input.budget.maxCostUnits > pendingAuthority.budget.maxCostUnits ||
      input.budget.maxDurationMs > pendingAuthority.budget.maxDurationMs
    ) {
      throw new ProviderPreflightError("authority_changed");
    }
    const persistedBudget = this.budgetConsumptionForTurn(proposal.turnId);
    const tracker = new BudgetTracker(
      input.budget,
      this.clock,
      persistedBudget.startedAt,
      persistedBudget.steps,
      persistedBudget.costUnits,
    );
    const decisionBudget = tracker.budgetSnapshot();
    if (input.disposition !== "approve" && input.disposition !== "deny") {
      throw new Error("Proposal disposition is invalid");
    }
    const approver = input.approver;
    if (input.disposition === "approve" && !approver) {
      throw new Error("An authenticated human approver is required");
    }
    const releaseActiveTurnReservation = this.reserveActiveTurnSlot();
    let controller: AbortController;
    try {
      controller = this.controllerFor(input.signal, tracker.remainingDurationMs());
    } catch (error) {
      releaseActiveTurnReservation();
      throw error;
    }
    if (nativeSignalAborted(controller.signal)) {
      this.releaseController(proposal.turnId, controller);
      releaseActiveTurnReservation();
      throw new ProviderTurnCancelledError();
    }
    const active: ActiveTurnState = {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      turnId: proposal.turnId,
      clientRequestId: input.clientRequestId,
      proposingAgent: proposal.actor,
      provider: decisionProvider,
      budget: decisionBudget,
      policyContext: input.policyContext,
      providerPlanSignature,
      tracker,
      externalSignal: input.signal,
      directionEpoch,
      controller,
      mode: "active",
      providerCommitInProgress: false,
      providerCommitPointReached: false,
    };
    let startGuardFailure: unknown;
    try {
      setLiveStateEntry(this.activeTurns, proposal.turnId, active);
      releaseActiveTurnReservation();
      if (!this.pendingProposals.delete(proposal.proposalId)) {
        throw new Error("Prepared proposal changed during decision initialization");
      }
    } catch (error) {
      releaseActiveTurnReservation();
      this.releaseController(proposal.turnId, controller);
      throw error;
    }
    try {
      if (input.disposition === "deny") {
        const denyCommitGuard = () => {
          try {
            if (!this.proposalIsDurablyPaused(proposal)) {
              startGuardFailure = new StaleTurnControlError("stale_turn_or_epoch");
              return false;
            }
            this.assertActiveEpoch(proposal.turnId, directionEpoch, controller);
            return true;
          } catch (error) {
            startGuardFailure = error;
            return false;
          }
        };
        await this.tools.denyApproval(proposal, "human_denied", denyCommitGuard);
        const result: TurnResult = {
          status: "denied",
          turnId: proposal.turnId,
          reasonCode: "human_denied",
          steps: tracker.steps,
          costUnits: tracker.costUnits,
        };
        this.cacheCompletedTurn(input.workspaceId, input.conversationId, input.clientRequestId, result);
        return result;
      }
      tracker.assertCanConsume(1, 0);
      const grant = await this.tools.grantApproval(
        proposal,
        approver as AuthenticatedHumanApprover,
        input.policyContext,
        MAX_APPROVAL_LIFETIME_MS,
        { requireExactGrant: true },
      );
      await this.tools.executeResume({
        proposal,
        grant,
        policyContext: input.policyContext,
        signal: controller.signal,
        requireExactGrant: true,
        startCommitGuard: () => {
          try {
            tracker.checkTime();
            if (nativeSignalAborted(controller.signal)) {
              startGuardFailure = controller.signal.reason instanceof BudgetExceededError
                ? controller.signal.reason
                : new ProviderTurnCancelledError();
              return false;
            }
            if (!this.proposalIsDurablyPaused(proposal)) {
              startGuardFailure = new StaleTurnControlError("stale_turn_or_epoch");
              return false;
            }
            if (this.providers.signatureFor(decisionProvider) !== pendingAuthority.providerPlanSignature) {
              startGuardFailure = new ProviderPreflightError("authority_changed");
              return false;
            }
            this.assertActiveEpoch(proposal.turnId, directionEpoch, controller);
            return true;
          } catch (error) {
            startGuardFailure = error;
            return false;
          }
        },
        onExecutionStarted: () => {
          tracker.commit(1, 0);
        },
      });

      const result = await this.finishProviderLoop({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        clientRequestId: input.clientRequestId,
        turnId: proposal.turnId,
        proposingAgent: proposal.actor,
        provider: decisionProvider,
        providerPlanSignature: active.providerPlanSignature,
        budget: decisionBudget,
        policyContext: input.policyContext,
        tracker,
        controller,
        directionEpoch,
      });
      this.cacheCompletedTurn(input.workspaceId, input.conversationId, input.clientRequestId, result);
      return result;
    } catch (error) {
      const retirementKey = this.epochKey(
        input.workspaceId,
        input.conversationId,
        proposal.turnId,
        directionEpoch,
      );
      const retirement = this.retiredEpochResults.get(retirementKey);
      if (retirement) {
        try {
          return await retirement;
        } finally {
          if (this.retiredEpochResults.get(retirementKey) === retirement) {
            this.retiredEpochResults.delete(retirementKey);
          }
        }
      }
      const durable = this.replayDurableTerminalForTurn(
        input.workspaceId,
        input.conversationId,
        proposal.turnId,
      );
      if (durable) return durable;
      const failure = error instanceof JournalCommitGuardError && startGuardFailure !== undefined
        ? startGuardFailure
        : error;
      this.beginFinishing(proposal.turnId, directionEpoch, controller);
      const result = await this.failTurn(
        input.workspaceId,
        input.conversationId,
        proposal.turnId,
        input.clientRequestId,
        failure,
        tracker,
      );
      this.cacheCompletedTurn(input.workspaceId, input.conversationId, input.clientRequestId, result);
      return result;
    } finally {
      this.releaseController(proposal.turnId, controller);
    }
  }

  cancelTurn(turnId: TurnId): boolean {
    const acceptedTurnId = captureRuntimeIdentifier(turnId, "turnId") as TurnId;
    const active = this.activeTurns.get(acceptedTurnId);
    if (!active || active.mode !== "active") return false;
    this.requestControllerAbort(
      active.controller,
      new DOMException("Turn cancelled by human", "AbortError"),
    );
    return true;
  }

  async stopTurn(input: StopTurnInput): Promise<TurnResult> {
    const acceptedInput = snapshotStopTurnInput(input);
    return this.controlOperation("stop", acceptedInput, "");
  }

  async steerTurn(input: SteerOrFollowUpInput): Promise<TurnResult> {
    input = snapshotSteerOrFollowUpInput(input);
    if (!input.content.trim() || input.content.length > 8_000) {
      throw new Error("Steering content must contain between 1 and 8000 characters");
    }
    if (input.turnId === undefined || input.directionEpoch === undefined) {
      const hasActiveConversationTurn = [...this.activeTurns.values()].some((active) =>
        active.workspaceId === input.workspaceId &&
        active.conversationId === input.conversationId &&
        active.mode === "active"
      );
      if (hasActiveConversationTurn) throw new StaleTurnControlError("stale_turn_or_epoch");
      return this.startMessage({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        clientRequestId: input.clientRequestId,
        content: input.content,
        user: input.human,
        proposingAgent: input.proposingAgent,
        provider: input.provider,
        budget: input.budget,
        policyContext: input.policyContext,
        signal: input.signal,
      }, "follow_up");
    }
    return this.controlOperation("steer", input, input.content);
  }

  private async performSend(
    input: SendMessageInput,
    directionKind: "initial" | "follow_up",
    requestHash: string,
    providerPlanSignature: string,
    releaseActiveTurnReservation: () => void,
  ): Promise<TurnResult> {
    const acceptedProvider = frozenProviderSelection(input.provider);
    if (this.providers.signatureFor(acceptedProvider) !== providerPlanSignature) {
      throw new ProviderPreflightError("authority_changed");
    }
    const turnId = asId<TurnId>(randomUUID(), "turn ID");
    const directionEpoch = 1;
    const startedAt = this.clock.now().getTime();
    const tracker = new BudgetTracker(input.budget, this.clock, startedAt);
    const acceptedBudget = tracker.budgetSnapshot();
    const controller = this.controllerFor(input.signal, tracker.remainingDurationMs());
    const messageId = asId<MessageId>(randomUUID(), "message ID");
    const now = this.clock.now().toISOString();

    try {
      await this.journal.appendBatch([
        this.event(input.workspaceId, input.conversationId, input.user, "user.message.accepted", {
          messageId,
          turnId,
          clientRequestId: input.clientRequestId,
          content: input.content,
        }),
        this.eventAt(input.workspaceId, input.conversationId, input.user, "direction.accepted", {
          directionId: randomUUID(),
          turnId,
          clientRequestId: input.clientRequestId,
          directionEpoch,
          kind: directionKind,
          messageId,
          contentHash: sha256Hex(input.content),
          requestHash,
          acceptedAt: now,
        }, now),
      ]);

      const active: ActiveTurnState = {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        clientRequestId: input.clientRequestId,
        turnId,
        proposingAgent: input.proposingAgent,
        provider: acceptedProvider,
        budget: acceptedBudget,
        policyContext: input.policyContext,
        providerPlanSignature,
        tracker,
        controller,
        externalSignal: input.signal,
        directionEpoch,
        mode: "active",
        providerCommitInProgress: false,
        providerCommitPointReached: false,
      };
      setLiveStateEntry(this.activeTurns, turnId, active);
      releaseActiveTurnReservation();
      return await this.runActiveTurn(active);
    } catch (error) {
      this.requestControllerAbort(controller, new DOMException("Turn failed", "AbortError"));
      throw error;
    }
  }

  private async finishProviderLoop(input: {
    readonly workspaceId: WorkspaceId;
    readonly conversationId: ConversationId;
    readonly clientRequestId: string;
    readonly turnId: TurnId;
    readonly proposingAgent: Actor;
    readonly provider: ProviderSelection;
    readonly providerPlanSignature: string;
    readonly budget: RuntimeBudget;
    readonly policyContext: PolicyContext;
    readonly tracker: BudgetTracker;
    readonly controller: AbortController;
    readonly directionEpoch: number;
  }): Promise<TurnResult> {
    for (;;) {
      const phase = await this.runProviderPhase(input);
      if (phase.kind === "continue") continue;
      if (phase.kind === "paused") {
        const releaseProposalSlot = this.reservePendingProposalSlot(phase.proposal.proposalId);
        try {
          await this.appendTurnCompleted(
            input.workspaceId,
            input.conversationId,
            input.turnId,
            input.clientRequestId,
            "paused",
            () => this.turnTerminalCommitGuard(
              input.turnId,
              input.directionEpoch,
              input.controller,
              false,
              true,
            ),
          );
          this.pendingProposals.set(phase.proposal.proposalId, Object.freeze({
            proposal: phase.proposal,
            budget: Object.freeze({ ...input.budget }),
            provider: input.provider,
            providerPlanSignature: input.providerPlanSignature,
          }));
        } catch (error) {
          this.pendingProposals.delete(phase.proposal.proposalId);
          throw error;
        } finally {
          releaseProposalSlot();
        }
        return {
          status: "paused",
          turnId: input.turnId,
          proposal: this.auditProposal(phase.proposal),
          decision: phase.decision,
          steps: input.tracker.steps,
          costUnits: input.tracker.costUnits,
        };
      }
      await this.appendTurnCompleted(
        input.workspaceId,
        input.conversationId,
        input.turnId,
        input.clientRequestId,
        "completed",
        () => this.turnTerminalCommitGuard(
          input.turnId,
          input.directionEpoch,
          input.controller,
          true,
          false,
        ),
      );
      return {
        status: "completed",
        turnId: input.turnId,
        assistantText: phase.text,
        steps: input.tracker.steps,
        costUnits: input.tracker.costUnits,
      };
    }
  }

  private async runProviderPhase(input: {
    readonly workspaceId: WorkspaceId;
    readonly conversationId: ConversationId;
    readonly turnId: TurnId;
    readonly proposingAgent: Actor;
    readonly provider: ProviderSelection;
    readonly providerPlanSignature: string;
    readonly policyContext: PolicyContext;
    readonly tracker: BudgetTracker;
    readonly controller: AbortController;
    readonly directionEpoch: number;
  }): Promise<PhaseResult> {
    input.tracker.checkTime();
    const history = projectProviderHistory(this.journal.snapshot(), input.conversationId);
    const routed = this.providers.routeTurn(input.provider, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      directionEpoch: input.directionEpoch,
      history,
      signal: input.controller.signal,
    }, input.providerPlanSignature);

    let active:
      | {
          readonly streamId: string;
          readonly providerId: ProviderId;
          readonly modelId: string;
          readonly providerRequestId: ProviderRequestId;
          readonly messageId: MessageId;
          deltaCount: number;
          text: string;
        }
      | undefined;
    let sawFinish = false;

    try {
      for await (const routedChunk of routed) {
        input.tracker.checkTime();
        if (routedChunk.kind === "provider_selected") {
          if (active) {
            await this.cancelStream(input, active);
          }
          active = {
            streamId: randomUUID(),
            providerId: routedChunk.providerId,
            modelId: routedChunk.modelId,
            providerRequestId: routedChunk.providerRequestId,
            messageId: asId<MessageId>(randomUUID(), "assistant message ID"),
            deltaCount: 0,
            text: "",
          };
          await this.appendProviderBatch(input, [
            this.event(input.workspaceId, input.conversationId, { kind: "system", id: "provider-router" }, "provider.selected", {
              turnId: input.turnId,
              providerId: routedChunk.providerId,
              modelId: routedChunk.modelId,
              protocolRevision: routedChunk.protocolRevision,
              credentialBindingRevision: routedChunk.credentialBindingRevision,
              providerRequestId: routedChunk.providerRequestId,
              fallbackIndex: routedChunk.fallbackIndex,
              directionEpoch: input.directionEpoch,
            }),
            this.event(input.workspaceId, input.conversationId, { kind: "provider", id: routedChunk.providerId }, "assistant.stream.started", {
              streamId: active.streamId,
              messageId: active.messageId,
              turnId: input.turnId,
              providerId: routedChunk.providerId,
              directionEpoch: input.directionEpoch,
            }),
          ]);
          continue;
        }

        if (!active) throw new Error("Provider output arrived before provider selection");
        const chunk = routedChunk.chunk;
        if (chunk.kind === "usage") continue;
        const trustedCost = this.costAccounting.costForProviderChunk({
          providerId: active.providerId,
          modelId: active.modelId,
          providerRequestId: active.providerRequestId,
          chunkKind: chunk.kind,
        });
        if (!Number.isFinite(trustedCost) || trustedCost < 0) {
          throw new Error("Trusted cost accounting returned an invalid value");
        }
        input.tracker.assertCanConsume(1, trustedCost);
        if (chunk.kind === "delta") {
          await this.appendProviderEvent(
            input,
            this.event(input.workspaceId, input.conversationId, { kind: "provider", id: active.providerId }, "assistant.stream.advanced", {
              streamId: active.streamId,
              turnId: input.turnId,
              delta: chunk.text,
              costUnits: trustedCost,
              directionEpoch: input.directionEpoch,
            }),
          );
          input.tracker.commit(1, trustedCost);
          active.deltaCount += 1;
          active.text += chunk.text;
          continue;
        }
        if (chunk.kind === "tool_proposal") {
          if (!("reviewedToolAuthority" in routedChunk)) {
            throw new ToolPreparationError("proposal_forged");
          }
          const proposal = this.tools.prepare({
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            turnId: input.turnId,
            directionEpoch: input.directionEpoch,
            actor: input.proposingAgent,
            toolId: chunk.toolId,
            arguments: chunk.arguments,
            summary: chunk.summary,
            reviewedToolAuthority: routedChunk.reviewedToolAuthority,
          });
          await this.appendProviderBatch(input, [
            this.event(input.workspaceId, input.conversationId, input.proposingAgent, "tool.proposed", {
              turnId: input.turnId,
              proposal: this.auditProposal(proposal),
              proposalFingerprint: proposalFingerprint(proposal),
              providerId: active.providerId,
            }),
            this.event(input.workspaceId, input.conversationId, { kind: "provider", id: active.providerId }, "assistant.stream.completed", {
              streamId: active.streamId,
              turnId: input.turnId,
              stopReason: "tool_pause",
              costUnits: trustedCost,
              directionEpoch: input.directionEpoch,
            }),
          ]);
          input.tracker.commit(1, trustedCost);
          this.assertActiveEpoch(input.turnId, input.directionEpoch, input.controller);
          const decision = await this.tools.evaluateAndRecord(
            proposal,
            input.policyContext,
            { requireExactGrant: true },
          );
          active = undefined;
          if (decision.outcome === "deny") {
            throw new Error(`Policy denied the prepared effect (${decision.reasonCode})`);
          }
          if (decision.outcome === "ask") return { kind: "paused", proposal, decision };
          throw new Error("Provider proposal did not require an exact grant");
        }
        sawFinish = true;
        await this.appendProviderEvent(
          input,
          this.event(input.workspaceId, input.conversationId, { kind: "provider", id: active.providerId }, "assistant.stream.completed", {
            streamId: active.streamId,
            turnId: input.turnId,
            stopReason: "complete",
            costUnits: trustedCost,
            directionEpoch: input.directionEpoch,
          }),
          false,
          true,
        );
        input.tracker.commit(1, trustedCost);
        const text = active.text;
        active = undefined;
        return { kind: "completed", text };
      }
      if (!sawFinish) throw new Error("Provider ended without an explicit finish chunk");
      throw new Error("Provider phase ended unexpectedly");
    } catch (error) {
      if (active) await this.cancelStream(input, active);
      throw error;
    }
  }

  private async cancelStream(
    input: {
      readonly workspaceId: WorkspaceId;
      readonly conversationId: ConversationId;
      readonly turnId: TurnId;
      readonly directionEpoch: number;
    },
    stream: { readonly streamId: string; readonly providerId: ProviderId; readonly deltaCount: number },
  ): Promise<void> {
    await this.journal.append(
      this.event(input.workspaceId, input.conversationId, { kind: "provider", id: stream.providerId }, "assistant.stream.cancelled", {
        streamId: stream.streamId,
        turnId: input.turnId,
        preservedDeltaCount: stream.deltaCount,
        directionEpoch: input.directionEpoch,
      }),
    );
  }

  private controlOperation(
    kind: "stop" | "steer",
    input: StopTurnInput | SteerTurnInput,
    content: string,
  ): Promise<TurnResult> {
    this.pruneInvalidPendingProposals();
    if (input.human.kind !== "human" || !input.human.id.trim()) {
      throw new Error("An authenticated human actor is required for turn control");
    }
    if (!input.clientRequestId.trim()) throw new Error("clientRequestId must not be empty");
    if (!Number.isSafeInteger(input.directionEpoch) || input.directionEpoch < 1) {
      throw new Error("directionEpoch must be a positive integer");
    }
    if (kind === "steer" && (!content.trim() || content.length > 8_000)) {
      throw new Error("Steering content must contain between 1 and 8000 characters");
    }

    const directionHash = sha256Hex(kind === "steer" ? content : "stop");
    const signature = canonicalHash({
      command: `turn.${kind}.v1`,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      directionEpoch: input.directionEpoch,
      human: {
        kind: input.human.kind,
        id: input.human.id,
        ...(input.human.label === undefined ? {} : { label: input.human.label }),
      },
      directionHash,
    });
    const key = this.requestKey(input.workspaceId, input.conversationId, input.clientRequestId);
    const inFlight = this.controlOperations.get(key);
    if (inFlight) {
      if (inFlight.signature !== signature) {
        throw new StaleTurnControlError("control_request_conflict");
      }
      return inFlight.operation;
    }
    const completedControl = this.completedControlOperations.get(key);
    if (completedControl) {
      if (completedControl.signature !== signature) {
        throw new StaleTurnControlError("control_request_conflict");
      }
      if (
        completedControl.result.status !== "paused" ||
        this.completedResultIsLivePaused(completedControl.result)
      ) {
        return Promise.resolve(completedControl.result);
      }
      this.completedControlOperations.delete(key);
    }

    const existing = this.journal.snapshot().find((event) => {
      if (
        event.workspaceId !== input.workspaceId ||
        event.conversationId !== input.conversationId ||
        event.type !== "human.control.requested"
      ) {
        return false;
      }
      return (event.payload as { clientRequestId: string }).clientRequestId === input.clientRequestId;
    });
    if (existing) {
      return Promise.resolve(this.replayControlResult(existing, input, kind, directionHash));
    }
    if (this.inFlightRequests.has(key) || this.journal.snapshot().some((event) =>
      event.workspaceId === input.workspaceId &&
      event.conversationId === input.conversationId &&
      event.type === "user.message.accepted" &&
      (event.payload as AuditPayloads["user.message.accepted"]).clientRequestId === input.clientRequestId
    )) {
      throw new StaleTurnControlError("control_request_conflict");
    }

    if (this.controlOperations.size >= MAX_COORDINATOR_CACHE_ENTRIES) {
      throw new RuntimeCapacityError();
    }
    const baseOperation = kind === "stop"
      ? this.performStop(input, directionHash)
      : this.performSteer(input as SteerTurnInput, directionHash);
    const operation = baseOperation
      .then((result) => {
        this.storeCompletedControlOperation(key, { signature, result });
        return result;
      })
      .finally(() => this.controlOperations.delete(key));
    setLiveStateEntry(this.controlOperations, key, { signature, operation });
    void operation.catch(() => undefined);
    return operation;
  }

  private async performStop(input: StopTurnInput, directionHash: string): Promise<TurnResult> {
    if (this.retiredEpochResults.size >= MAX_COORDINATOR_CACHE_ENTRIES) {
      throw new RuntimeCapacityError();
    }
    const active = this.claimActiveEpoch(input);
    const epochKey = this.epochKey(
      input.workspaceId,
      input.conversationId,
      input.turnId,
      input.directionEpoch,
    );
    const completion = deferred<TurnResult>();
    setLiveStateEntry(this.retiredEpochResults, epochKey, completion.promise);
    const controlId = randomUUID();
    const requestedAt = this.clock.now().toISOString();
    let requestAcknowledged = false;

    try {
      await this.journal.append(
        this.eventAt(input.workspaceId, input.conversationId, input.human, "human.control.requested", {
          controlId,
          controlKind: "stop",
          turnId: input.turnId,
          clientRequestId: input.clientRequestId,
          directionEpoch: input.directionEpoch,
          directionHash,
          requestedAt,
        }, requestedAt),
      );
      requestAcknowledged = true;
      this.discardPendingProposalsForTurn(input.turnId);
      this.requestControllerAbort(
        active.controller,
        new DirectionEpochRetiredError(input.turnId, input.directionEpoch),
      );

      const stoppedAt = this.clock.now().toISOString();
      await this.journal.append(
        this.eventAt(
          input.workspaceId,
          input.conversationId,
          { kind: "system", id: "runtime-coordinator" },
          "turn.stopped",
          {
            controlId,
            turnId: input.turnId,
            clientRequestId: input.clientRequestId,
            directionEpoch: input.directionEpoch,
            reasonCode: "human_stop",
            stoppedAt,
          },
          stoppedAt,
        ),
      );
      const result: TurnResult = {
        status: "stopped",
        turnId: input.turnId,
        reasonCode: "human_stop",
        steps: active.tracker.steps,
        costUnits: active.tracker.costUnits,
      };
      completion.resolve(result);
      return result;
    } catch (error) {
      if (!requestAcknowledged) {
        active.mode = "active";
        this.retiredEpochResults.delete(epochKey);
        completion.reject(error);
        throw error;
      }
      const interrupted: TurnResult = {
        status: "interrupted",
        turnId: input.turnId,
        reasonCode: "interrupted_stop_requires_reconciliation",
        steps: active.tracker.steps,
        costUnits: active.tracker.costUnits,
      };
      completion.resolve(interrupted);
      return interrupted;
    }
  }

  private async performSteer(input: SteerTurnInput, directionHash: string): Promise<TurnResult> {
    if (this.retiredEpochResults.size >= MAX_COORDINATOR_CACHE_ENTRIES) {
      throw new RuntimeCapacityError();
    }
    const active = this.claimActiveEpoch(input);
    const retiredKey = this.epochKey(
      input.workspaceId,
      input.conversationId,
      input.turnId,
      input.directionEpoch,
    );
    const completion = deferred<TurnResult>();
    setLiveStateEntry(this.retiredEpochResults, retiredKey, completion.promise);
    const nextDirectionEpoch = input.directionEpoch + 1;
    const controlId = randomUUID();
    const directionId = randomUUID();
    const messageId = asId<MessageId>(randomUUID(), "steering message ID");
    const acceptedAt = this.clock.now().toISOString();
    let requestAcknowledged = false;

    try {
      await this.journal.appendBatch([
        this.eventAt(input.workspaceId, input.conversationId, input.human, "human.control.requested", {
          controlId,
          controlKind: "steer",
          turnId: input.turnId,
          clientRequestId: input.clientRequestId,
          directionEpoch: input.directionEpoch,
          directionHash,
          requestedAt: acceptedAt,
        }, acceptedAt),
        this.eventAt(input.workspaceId, input.conversationId, input.human, "user.message.accepted", {
          messageId,
          turnId: input.turnId,
          clientRequestId: input.clientRequestId,
          content: input.content,
        }, acceptedAt),
        this.eventAt(input.workspaceId, input.conversationId, input.human, "direction.accepted", {
          directionId,
          turnId: input.turnId,
          clientRequestId: input.clientRequestId,
          directionEpoch: nextDirectionEpoch,
          kind: "steer",
          messageId,
          contentHash: directionHash,
          acceptedAt,
        }, acceptedAt),
        this.eventAt(
          input.workspaceId,
          input.conversationId,
          { kind: "system", id: "runtime-coordinator" },
          "turn.steered",
          {
            controlId,
            turnId: input.turnId,
            clientRequestId: input.clientRequestId,
            retiredDirectionEpoch: input.directionEpoch,
            nextDirectionEpoch,
            directionId,
            steeredAt: acceptedAt,
          },
          acceptedAt,
        ),
      ]);
      requestAcknowledged = true;

      this.discardPendingProposalsForTurn(input.turnId);

      const nextController = this.controllerFor(active.externalSignal, active.tracker.remainingDurationMs());
      const nextActive: ActiveTurnState = {
        ...active,
        clientRequestId: input.clientRequestId,
        directionEpoch: nextDirectionEpoch,
        controller: nextController,
        mode: "active",
        providerCommitInProgress: false,
        providerCommitPointReached: false,
        pendingAbortReason: undefined,
      };
      setLiveStateEntry(this.activeTurns, input.turnId, nextActive);
      this.requestControllerAbort(
        active.controller,
        new DirectionEpochRetiredError(input.turnId, input.directionEpoch),
      );

      const continuation = this.runActiveTurn(nextActive);
      continuation.then(completion.resolve, completion.reject);
      return await continuation;
    } catch (error) {
      if (!requestAcknowledged) {
        active.mode = "active";
        this.retiredEpochResults.delete(retiredKey);
        completion.reject(error);
        throw error;
      }
      const interrupted: TurnResult = {
        status: "interrupted",
        turnId: input.turnId,
        reasonCode: "interrupted_steered_phase_requires_resume",
        steps: active.tracker.steps,
        costUnits: active.tracker.costUnits,
      };
      completion.resolve(interrupted);
      return interrupted;
    }
  }

  private claimActiveEpoch(input: StopTurnInput): ActiveTurnState {
    const active = this.activeTurns.get(input.turnId);
    if (
      !active ||
      active.workspaceId !== input.workspaceId ||
      active.conversationId !== input.conversationId ||
      active.directionEpoch !== input.directionEpoch ||
      active.mode !== "active"
    ) {
      throw new StaleTurnControlError("stale_turn_or_epoch");
    }
    active.mode = "retiring";
    return active;
  }

  private async runActiveTurn(active: ActiveTurnState): Promise<TurnResult> {
    try {
      return await this.finishProviderLoop(active);
    } catch (error) {
      const retirementKey = this.epochKey(
        active.workspaceId,
        active.conversationId,
        active.turnId,
        active.directionEpoch,
      );
      const retirement = this.retiredEpochResults.get(retirementKey);
      if (retirement) {
        try {
          return await retirement;
        } finally {
          if (this.retiredEpochResults.get(retirementKey) === retirement) {
            this.retiredEpochResults.delete(retirementKey);
          }
        }
      }
      const durable = this.replayDurableTerminalForTurn(
        active.workspaceId,
        active.conversationId,
        active.turnId,
      );
      if (durable) return durable;
      this.beginFinishing(active.turnId, active.directionEpoch, active.controller);
      return await this.failTurn(
        active.workspaceId,
        active.conversationId,
        active.turnId,
        active.clientRequestId,
        error,
        active.tracker,
      );
    } finally {
      this.releaseController(active.turnId, active.controller);
    }
  }

  private replayControlResult(
    event: AuditEvent,
    input: StopTurnInput,
    kind: "stop" | "steer",
    directionHash: string,
  ): TurnResult {
    const item = event.payload as AuditPayloads["human.control.requested"];
    if (
      item.controlKind !== kind ||
      item.turnId !== input.turnId ||
      item.directionEpoch !== input.directionEpoch ||
      item.directionHash !== directionHash ||
      event.actor.kind !== input.human.kind ||
      event.actor.id !== input.human.id ||
      event.actor.label !== input.human.label
    ) {
      throw new StaleTurnControlError("control_request_conflict");
    }
    const usage = this.budgetConsumptionForTurn(input.turnId);
    const later = this.journal.snapshot().filter((candidate) =>
      candidate.workspaceId === input.workspaceId &&
      candidate.conversationId === input.conversationId &&
      candidate.globalSequence > event.globalSequence &&
      "turnId" in candidate.payload &&
      candidate.payload.turnId === input.turnId
    );
    if (kind === "stop" && later.some((candidate) =>
      candidate.type === "turn.stopped" &&
      (candidate.payload as AuditPayloads["turn.stopped"]).controlId === item.controlId
    )) {
      return {
        status: "stopped",
        turnId: input.turnId,
        reasonCode: "human_stop",
        steps: usage.steps,
        costUnits: usage.costUnits,
      };
    }
    if (kind === "steer") {
      const terminal = [...later].reverse().find((candidate) =>
        candidate.type === "turn.completed" ||
        candidate.type === "turn.failed" ||
        candidate.type === "turn.stopped" ||
        candidate.type === "approval.denied"
      );
      if (terminal?.type === "turn.failed") {
        const reasonCode = (terminal.payload as AuditPayloads["turn.failed"]).reasonCode;
        return {
          status: reasonCode === "cancelled_by_human" ? "cancelled" : "failed",
          turnId: input.turnId,
          reasonCode,
          steps: usage.steps,
          costUnits: usage.costUnits,
        };
      }
      if (terminal?.type === "turn.stopped") {
        return {
          status: "stopped",
          turnId: input.turnId,
          reasonCode: (terminal.payload as AuditPayloads["turn.stopped"]).reasonCode,
          steps: usage.steps,
          costUnits: usage.costUnits,
        };
      }
      if (terminal?.type === "approval.denied") {
        return {
          status: "denied",
          turnId: input.turnId,
          reasonCode: (terminal.payload as AuditPayloads["approval.denied"]).reasonCode,
          steps: usage.steps,
          costUnits: usage.costUnits,
        };
      }
      if (terminal?.type === "turn.completed") {
        const status = (terminal.payload as AuditPayloads["turn.completed"]).status;
        if (status === "paused") {
          return this.livePausedResultForTurn(input.turnId) ?? {
            status: "failed",
            turnId: input.turnId,
            reasonCode: "paused_turn_requires_fresh_proposal",
            steps: usage.steps,
            costUnits: usage.costUnits,
          };
        }
        if (status === "denied") {
          return {
            status: "denied",
            turnId: input.turnId,
            reasonCode: "human_denied",
            steps: usage.steps,
            costUnits: usage.costUnits,
          };
        }
        return {
          status: "completed",
          turnId: input.turnId,
          assistantText: assistantTextForTurn(
            this.journal.snapshot(),
            input.conversationId,
            input.turnId,
          ),
          steps: usage.steps,
          costUnits: usage.costUnits,
        };
      }
    }
    return {
      status: "interrupted",
      turnId: input.turnId,
      reasonCode: `interrupted_${kind}_requires_reconciliation`,
      steps: usage.steps,
      costUnits: usage.costUnits,
    };
  }

  private async appendProviderEvent<Type extends AuditEventType>(
    input: {
      readonly workspaceId: WorkspaceId;
      readonly conversationId: ConversationId;
      readonly turnId: TurnId;
      readonly directionEpoch: number;
      readonly controller: AbortController;
    },
    draft: DraftAuditEvent<Type>,
    allowFinishing = false,
    transitionToFinishing = false,
  ): Promise<AuditEvent<Type>> {
    const active = this.beginProviderCommit(
      input.turnId,
      input.directionEpoch,
      input.controller,
      allowFinishing,
    );
    try {
      return await this.journal.appendGuarded(
        draft,
        () => this.providerCommitGuard(active, allowFinishing, transitionToFinishing),
      );
    } catch (error) {
      const active = this.activeTurns.get(input.turnId);
      if (
        !active ||
        active.directionEpoch !== input.directionEpoch ||
        active.controller !== input.controller ||
        active.mode === "retiring"
      ) {
        throw new DirectionEpochRetiredError(input.turnId, input.directionEpoch);
      }
      throw error;
    } finally {
      this.endProviderCommit(active);
    }
  }

  private async appendProviderBatch(
    input: {
      readonly turnId: TurnId;
      readonly directionEpoch: number;
      readonly controller: AbortController;
    },
    drafts: readonly DraftAuditEvent[],
  ): Promise<readonly AuditEvent[]> {
    const commit = this.beginProviderCommit(
      input.turnId,
      input.directionEpoch,
      input.controller,
    );
    try {
      return await this.journal.appendBatchGuarded(
        drafts,
        () => this.providerCommitGuard(commit),
      );
    } catch (error) {
      const active = this.activeTurns.get(input.turnId);
      if (
        !active ||
        active.directionEpoch !== input.directionEpoch ||
        active.controller !== input.controller ||
        active.mode === "retiring"
      ) {
        throw new DirectionEpochRetiredError(input.turnId, input.directionEpoch);
      }
      throw error;
    } finally {
      this.endProviderCommit(commit);
    }
  }

  private beginProviderCommit(
    turnId: TurnId,
    directionEpoch: number,
    controller: AbortController,
    allowFinishing = false,
  ): ActiveTurnState {
    const active = this.assertActiveEpoch(turnId, directionEpoch, controller, allowFinishing);
    if (active.providerCommitInProgress || controller.signal.aborted) {
      throw new DirectionEpochRetiredError(turnId, directionEpoch);
    }
    active.providerCommitInProgress = true;
    active.providerCommitPointReached = false;
    return active;
  }

  private providerCommitGuard(
    active: ActiveTurnState,
    allowFinishing = false,
    transitionToFinishing = false,
  ): boolean {
    const current = this.activeTurns.get(active.turnId);
    const valid = current === active &&
      active.providerCommitInProgress &&
      !active.providerCommitPointReached &&
      !active.pendingAbortReason &&
      !active.controller.signal.aborted &&
      !this.hasDurableWholeTurnTerminal(active.workspaceId, active.conversationId, active.turnId) &&
      (active.mode === "active" || (allowFinishing && active.mode === "finishing"));
    if (valid) {
      active.providerCommitPointReached = true;
      if (transitionToFinishing) active.mode = "finishing";
    }
    return valid;
  }

  private turnTerminalCommitGuard(
    turnId: TurnId,
    directionEpoch: number,
    controller: AbortController,
    allowFinishing: boolean,
    transitionToFinishing: boolean,
  ): boolean {
    const active = this.activeTurns.get(turnId);
    const terminalAuthorityValid = active
      ? !this.hasDurableWholeTurnTerminal(active.workspaceId, active.conversationId, turnId)
      : false;
    const valid = Boolean(
      active &&
      active.directionEpoch === directionEpoch &&
      active.controller === controller &&
      !active.pendingAbortReason &&
      !controller.signal.aborted &&
      (active.mode === "active" || (allowFinishing && active.mode === "finishing")) &&
      terminalAuthorityValid
    );
    if (valid && transitionToFinishing && active) active.mode = "finishing";
    return valid;
  }

  private endProviderCommit(active: ActiveTurnState): void {
    active.providerCommitInProgress = false;
    active.providerCommitPointReached = false;
    const pending = active.pendingAbortReason;
    active.pendingAbortReason = undefined;
    if (pending && !active.controller.signal.aborted) active.controller.abort(pending);
  }

  private assertActiveEpoch(
    turnId: TurnId,
    directionEpoch: number,
    controller: AbortController,
    allowFinishing = false,
  ): ActiveTurnState {
    const active = this.activeTurns.get(turnId);
    if (
      !active ||
      active.directionEpoch !== directionEpoch ||
      active.controller !== controller ||
      controller.signal.aborted ||
      (active.mode !== "active" && !(allowFinishing && active.mode === "finishing"))
    ) {
      throw new DirectionEpochRetiredError(turnId, directionEpoch);
    }
    return active;
  }

  private beginFinishing(
    turnId: TurnId,
    directionEpoch: number,
    controller: AbortController,
  ): void {
    const active = this.activeTurns.get(turnId);
    if (
      !active ||
      active.directionEpoch !== directionEpoch ||
      active.controller !== controller ||
      active.mode === "retiring"
    ) {
      throw new DirectionEpochRetiredError(turnId, directionEpoch);
    }
    active.mode = "finishing";
  }

  private epochKey(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
    directionEpoch: number,
  ): string {
    return JSON.stringify([workspaceId, conversationId, turnId, directionEpoch]);
  }

  private latestDirectionEpoch(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
  ): number {
    let latest = 1;
    for (const event of this.journal.snapshot()) {
      if (
        event.workspaceId !== workspaceId ||
        event.conversationId !== conversationId ||
        event.type !== "direction.accepted"
      ) {
        continue;
      }
      const item = event.payload as AuditPayloads["direction.accepted"];
      if (item.turnId === turnId) latest = Math.max(latest, item.directionEpoch);
    }
    return latest;
  }

  private directionEpochIsRetired(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
    directionEpoch: number,
  ): boolean {
    return this.journal.snapshot().some((event) => {
      if (event.workspaceId !== workspaceId || event.conversationId !== conversationId) return false;
      if (event.type === "human.control.requested") {
        const item = event.payload as AuditPayloads["human.control.requested"];
        return item.turnId === turnId && item.directionEpoch === directionEpoch;
      }
      if (event.type === "turn.steered") {
        const item = event.payload as AuditPayloads["turn.steered"];
        return item.turnId === turnId && item.retiredDirectionEpoch === directionEpoch;
      }
      if (event.type === "turn.stopped") {
        const item = event.payload as AuditPayloads["turn.stopped"];
        return item.turnId === turnId && item.directionEpoch === directionEpoch;
      }
      return false;
    });
  }

  private reservePendingProposalSlot(proposalId: ProposalId): () => void {
    this.pruneInvalidPendingProposals();
    if (
      this.pendingProposals.has(proposalId) ||
      this.pendingProposalReservations.has(proposalId) ||
      this.pendingProposals.size + this.pendingProposalReservations.size >= MAX_COORDINATOR_CACHE_ENTRIES
    ) {
      throw new RuntimeCapacityError();
    }
    this.pendingProposalReservations.add(proposalId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingProposalReservations.delete(proposalId);
    };
  }

  private reserveActiveTurnSlot(): () => void {
    if (this.activeTurns.size + this.activeTurnReservations >= MAX_COORDINATOR_CACHE_ENTRIES) {
      throw new RuntimeCapacityError();
    }
    this.activeTurnReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTurnReservations -= 1;
    };
  }

  private discardPendingProposalsForTurn(turnId: TurnId): void {
    for (const [proposalId, authority] of this.pendingProposals) {
      if (authority.proposal.turnId === turnId) this.pendingProposals.delete(proposalId);
    }
  }

  private pruneInvalidPendingProposals(): void {
    for (const [proposalId, authority] of this.pendingProposals) {
      if (
        !this.proposalIsDurablyPaused(authority.proposal) ||
        !this.pendingProviderAuthorityIsCurrent(authority)
      ) {
        this.pendingProposals.delete(proposalId);
      }
    }
  }

  private pendingProviderAuthorityIsCurrent(authority: PendingProposalAuthority): boolean {
    try {
      return this.providers.signatureFor(authority.provider) === authority.providerPlanSignature;
    } catch {
      return false;
    }
  }

  private proposalIsDurablyPaused(proposal: PreparedToolProposal): boolean {
    const relevant = this.journal.snapshot().filter((event) =>
      event.workspaceId === proposal.workspaceId &&
      event.conversationId === proposal.conversationId &&
      "turnId" in event.payload &&
      event.payload.turnId === proposal.turnId
    );
    const proposed = [...relevant].reverse().find((event) => event.type === "tool.proposed");
    if (!proposed) return false;
    const proposedPayload = proposed.payload as AuditPayloads["tool.proposed"];
    if (
      proposedPayload.proposal.proposalId !== proposal.proposalId ||
      proposedPayload.proposalFingerprint !== proposalFingerprint(proposal) ||
      canonicalHash(proposedPayload.proposal) !== canonicalHash(this.auditProposal(proposal))
    ) {
      return false;
    }

    if (relevant.some((event) =>
      event.globalSequence < proposed.globalSequence &&
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.stopped" ||
        event.type === "approval.denied")
    )) return false;

    const terminals = relevant.filter((event) =>
      event.globalSequence > proposed.globalSequence &&
      (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.stopped" ||
        event.type === "turn.steered" ||
        event.type === "approval.denied"
      )
    );
    if (
      terminals.length !== 1 ||
      terminals[0].type !== "turn.completed" ||
      (terminals[0].payload as AuditPayloads["turn.completed"]).status !== "paused"
    ) {
      return false;
    }
    const terminal = terminals[0];

    const policy = [...relevant].reverse().find((event) =>
      event.type === "policy.decided" &&
      event.globalSequence > proposed.globalSequence &&
      event.globalSequence < terminal.globalSequence &&
      (event.payload as AuditPayloads["policy.decided"]).proposalId === proposal.proposalId
    );
    return policy !== undefined &&
      (policy.payload as AuditPayloads["policy.decided"]).decision.outcome === "ask";
  }

  private sendRequestHash(
    input: SendMessageInput,
    directionKind: "initial" | "follow_up",
    providerPlanSignature: string,
  ): string {
    return canonicalHash({
      command: "conversation.message.send.v2",
      directionKind,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      human: {
        kind: input.user.kind,
        id: input.user.id,
        ...(input.user.label === undefined ? {} : { label: input.user.label }),
      },
      proposingAgent: {
        kind: input.proposingAgent.kind,
        id: input.proposingAgent.id,
        ...(input.proposingAgent.label === undefined ? {} : { label: input.proposingAgent.label }),
      },
      content: input.content,
      provider: {
        plan: providerPlanSignature,
        candidates: input.provider.candidates.map((candidate) => ({ ...candidate })),
        requiredCapabilities: [...input.provider.requiredCapabilities].sort(),
      },
      budget: input.budget,
      policyContext: {
        grantedDataScopes: [...input.policyContext.grantedDataScopes].sort(),
        grantedNetworkScopes: [...input.policyContext.grantedNetworkScopes].sort(),
      },
    });
  }

  private durableSendRequestHash(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
    clientRequestId: string,
  ): string | undefined {
    for (const event of this.journal.snapshot()) {
      if (
        event.workspaceId !== workspaceId ||
        event.conversationId !== conversationId ||
        event.type !== "direction.accepted"
      ) {
        continue;
      }
      const item = event.payload as AuditPayloads["direction.accepted"];
      if (
        item.turnId === turnId &&
        item.clientRequestId === clientRequestId &&
        (item.kind === "initial" || item.kind === "follow_up")
      ) {
        return item.requestHash;
      }
    }
    return undefined;
  }

  private cacheCompletedTurn(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    clientRequestId: string,
    result: TurnResult,
  ): void {
    const key = this.requestKey(workspaceId, conversationId, clientRequestId);
    const signature = this.completedRequests.get(key)?.signature ??
      this.durableSendRequestHash(workspaceId, conversationId, result.turnId, clientRequestId);
    if (signature) this.storeCompletedRequest(key, { signature, result });
  }

  private storeCompletedRequest(
    key: string,
    value: { readonly signature: string; readonly result: TurnResult },
  ): void {
    this.pruneInvalidPendingProposals();
    if (this.completedRequests.has(key)) {
      this.completedRequests.delete(key);
      this.completedRequests.set(key, value);
      return;
    }
    if (this.completedRequests.size >= MAX_COORDINATOR_CACHE_ENTRIES) {
      for (const [candidateKey, candidate] of this.completedRequests) {
        if (!this.completedResultIsLivePaused(candidate.result)) {
          this.completedRequests.delete(candidateKey);
          break;
        }
      }
    }
    if (this.completedRequests.size < MAX_COORDINATOR_CACHE_ENTRIES) {
      this.completedRequests.set(key, value);
    }
  }

  private storeCompletedControlOperation(
    key: string,
    value: { readonly signature: string; readonly result: TurnResult },
  ): void {
    this.pruneInvalidPendingProposals();
    if (this.completedControlOperations.has(key)) {
      this.completedControlOperations.delete(key);
      this.completedControlOperations.set(key, value);
      return;
    }
    if (this.completedControlOperations.size >= MAX_COORDINATOR_CACHE_ENTRIES) {
      for (const [candidateKey, candidate] of this.completedControlOperations) {
        if (!this.completedResultIsLivePaused(candidate.result)) {
          this.completedControlOperations.delete(candidateKey);
          break;
        }
      }
    }
    if (this.completedControlOperations.size < MAX_COORDINATOR_CACHE_ENTRIES) {
      this.completedControlOperations.set(key, value);
    }
  }

  private completedResultIsLivePaused(result: TurnResult): boolean {
    if (result.status !== "paused") return false;
    const authority = this.pendingProposals.get(result.proposal.proposalId);
    return authority !== undefined &&
      authority.proposal.turnId === result.turnId &&
      this.proposalIsDurablyPaused(authority.proposal);
  }

  private async failTurn(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
    clientRequestId: string,
    error: unknown,
    tracker: BudgetTracker,
  ): Promise<TurnResult> {
    this.discardPendingProposalsForTurn(turnId);
    const cancelled =
      error instanceof ProviderTurnCancelledError ||
      error instanceof JournalCommitGuardError;
    const reasonCode = cancelled ? "cancelled_by_human" : safeTurnFailureCode(error);
    await this.journal.append(
      this.event(workspaceId, conversationId, { kind: "system", id: "runtime-coordinator" }, "turn.failed", {
        turnId,
        clientRequestId,
        reasonCode,
      }),
    );
    return {
      status: cancelled ? "cancelled" : "failed",
      turnId,
      reasonCode,
      steps: tracker.steps,
      costUnits: tracker.costUnits,
    };
  }

  private async appendTurnCompleted(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
    clientRequestId: string,
    status: "completed" | "paused" | "denied",
    commitGuard?: () => boolean,
  ): Promise<void> {
    const draft = this.event(
      workspaceId,
      conversationId,
      { kind: "system", id: "runtime-coordinator" },
      "turn.completed",
      { turnId, clientRequestId, status },
    );
    if (commitGuard) await this.journal.appendGuarded(draft, commitGuard);
    else await this.journal.append(draft);
  }

  private hasDurableWholeTurnTerminal(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
  ): boolean {
    return this.journal.snapshot().some((event) =>
      event.workspaceId === workspaceId &&
      event.conversationId === conversationId &&
      "turnId" in event.payload &&
      event.payload.turnId === turnId &&
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.stopped" ||
        event.type === "approval.denied")
    );
  }

  private event<Type extends AuditEventType>(
    workspaceId: WorkspaceId,
    conversationId: ConversationId | undefined,
    actor: Actor,
    type: Type,
    payload: DraftAuditEvent<Type>["payload"],
  ): DraftAuditEvent<Type> {
    return this.eventAt(
      workspaceId,
      conversationId,
      actor,
      type,
      payload,
      this.clock.now().toISOString(),
    );
  }

  private eventAt<Type extends AuditEventType>(
    workspaceId: WorkspaceId,
    conversationId: ConversationId | undefined,
    actor: Actor,
    type: Type,
    payload: DraftAuditEvent<Type>["payload"],
    timestamp: string,
  ): DraftAuditEvent<Type> {
    return {
      eventId: asId<EventId>(randomUUID(), "event ID"),
      workspaceId,
      ...(conversationId ? { conversationId } : {}),
      actor,
      timestamp,
      payloadSchemaVersion: type === "provider.selected" ? 2 : 1,
      type,
      payload,
    };
  }

  private controllerFor(external: AbortSignal | undefined, durationMs: number): AbortController {
    const controller = new AbortController();
    const validExternal = external !== undefined && isNativeAbortSignal(external) ? external : undefined;
    const forwardExternalAbort = () => this.requestControllerAbort(
      controller,
      new DOMException("Turn cancelled by external control", "AbortError"),
    );
    const timeout = setTimeout(
      () => this.requestControllerAbort(controller, new BudgetExceededError("time_budget")),
      durationMs,
    );
    timeout.unref?.();
    let cleaned = false;
    let internalListenerAttached = false;
    let externalListenerAttached = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      if (validExternal && externalListenerAttached) {
        removeNativeAbortListener(validExternal, forwardExternalAbort);
      }
      if (internalListenerAttached) {
        removeNativeAbortListener(controller.signal, cleanup);
      }
      this.controllerCleanups.delete(controller);
    };
    try {
      this.controllerCleanups.set(controller, cleanup);
      addNativeAbortListener(controller.signal, cleanup);
      internalListenerAttached = true;
      if (validExternal && nativeSignalAborted(validExternal)) forwardExternalAbort();
      else if (validExternal) {
        addNativeAbortListener(validExternal, forwardExternalAbort);
        externalListenerAttached = true;
      }
      return controller;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private requestControllerAbort(controller: AbortController, reason: Error): void {
    const active = [...this.activeTurns.values()].find((candidate) => candidate.controller === controller);
    if (active?.providerCommitInProgress) {
      active.pendingAbortReason = reason;
      return;
    }
    if (!controller.signal.aborted) controller.abort(reason);
  }

  private releaseController(turnId: TurnId, controller: AbortController): void {
    this.controllerCleanups.get(controller)?.();
    if (this.activeTurns.get(turnId)?.controller === controller) this.activeTurns.delete(turnId);
  }

  private budgetConsumptionForTurn(turnId: TurnId): {
    readonly startedAt: number;
    readonly steps: number;
    readonly costUnits: number;
  } {
    const relevant = this.journal.snapshot().filter(
      (event) => "turnId" in event.payload && event.payload.turnId === turnId,
    );
    const accepted = relevant.find((event) => event.type === "user.message.accepted");
    // These audit events carry charges from the trusted accounting port. Provider-reported
    // token usage chunks are intentionally not part of runtime cost reconstruction.
    const advanced = relevant.filter((event) => event.type === "assistant.stream.advanced");
    const completed = relevant.filter((event) => event.type === "assistant.stream.completed");
    const toolStarts = relevant.filter((event) => event.type === "tool.execution.started").length;
    return {
      startedAt: accepted ? Date.parse(accepted.timestamp) : this.clock.now().getTime(),
      steps: advanced.length + completed.length + toolStarts,
      costUnits: [...advanced, ...completed].reduce(
        (total, event) => total + Number((event.payload as { costUnits?: number }).costUnits ?? 0),
        0,
      ),
    };
  }

  private replayResult(existing: ReturnType<typeof findExistingTurn> & {}): TurnResult {
    if (!existing) throw new Error("Existing turn required");
    this.pruneInvalidPendingProposals();
    const usage = this.budgetConsumptionForTurn(existing.turnId);
    if (existing.status === "completed") {
      const events = this.journal.snapshot();
      const conversationId = events.find((event) => {
        return (
          event.type === "user.message.accepted" &&
          (event.payload as { turnId: TurnId }).turnId === existing.turnId
        );
      })?.conversationId as ConversationId;
      return {
        status: "completed",
        turnId: existing.turnId,
        assistantText: assistantTextForTurn(events, conversationId, existing.turnId),
        steps: usage.steps,
        costUnits: usage.costUnits,
      };
    }
    if (existing.status === "paused") {
      const live = this.livePausedResultForTurn(existing.turnId);
      if (live) return live;
      return {
        status: "failed",
        turnId: existing.turnId,
        reasonCode: "paused_turn_requires_fresh_proposal",
        steps: usage.steps,
        costUnits: usage.costUnits,
      };
    }
    if (existing.status === "denied") {
      return {
        status: "denied",
        turnId: existing.turnId,
        reasonCode: existing.reasonCode ?? "human_denied",
        steps: usage.steps,
        costUnits: usage.costUnits,
      };
    }
    return {
      status: existing.status === "failed" && existing.reasonCode === "cancelled_by_human"
        ? "cancelled"
        : existing.status,
      turnId: existing.turnId,
      reasonCode: existing.reasonCode ?? `existing_${existing.status}`,
      steps: usage.steps,
      costUnits: usage.costUnits,
    };
  }

  private livePausedResultForTurn(
    turnId: TurnId,
  ): Extract<TurnResult, { readonly status: "paused" }> | undefined {
    const authority = [...this.pendingProposals.values()].find((candidate) =>
      candidate.proposal.turnId === turnId && this.proposalIsDurablyPaused(candidate.proposal)
    );
    const proposal = authority?.proposal;
    if (!proposal) return undefined;
    const decisionEvent = [...this.journal.snapshot()].reverse().find((event) =>
      event.workspaceId === proposal.workspaceId &&
      event.conversationId === proposal.conversationId &&
      event.type === "policy.decided" &&
      (event.payload as AuditPayloads["policy.decided"]).turnId === proposal.turnId &&
      (event.payload as AuditPayloads["policy.decided"]).proposalId === proposal.proposalId
    );
    if (!decisionEvent) return undefined;
    const usage = this.budgetConsumptionForTurn(turnId);
    return {
      status: "paused",
      turnId,
      proposal: this.auditProposal(proposal),
      decision: (decisionEvent.payload as AuditPayloads["policy.decided"]).decision,
      steps: usage.steps,
      costUnits: usage.costUnits,
    };
  }

  private replayDurableTerminalForTurn(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    turnId: TurnId,
  ): TurnResult | undefined {
    const events = this.journal.snapshot();
    const accepted = events.find((event) =>
      event.workspaceId === workspaceId &&
      event.conversationId === conversationId &&
      event.type === "user.message.accepted" &&
      (event.payload as AuditPayloads["user.message.accepted"]).turnId === turnId
    );
    if (!accepted) return undefined;
    const explicitTerminal = events.some((event) =>
      event.workspaceId === workspaceId &&
      event.conversationId === conversationId &&
      "turnId" in event.payload &&
      event.payload.turnId === turnId &&
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.stopped" ||
        event.type === "approval.denied")
    );
    if (!explicitTerminal) return undefined;
    const clientRequestId = (accepted.payload as AuditPayloads["user.message.accepted"]).clientRequestId;
    const existing = findExistingTurn(events, conversationId, clientRequestId);
    if (!existing || existing.turnId !== turnId || existing.status === "paused") return undefined;
    return this.replayResult(existing);
  }

  private auditProposal(proposal: PreparedToolProposal): AuditedToolProposal {
    const { arguments: _sensitiveArguments, ...audited } = proposal;
    return Object.freeze(audited);
  }

  private requestKey(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    clientRequestId: string,
  ): string {
    return canonicalStringify([workspaceId, conversationId, clientRequestId]);
  }
}
