import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AGENT_COLOR_TOKENS,
  AGENT_MARK_TOKENS,
  AGENT_STATUSES,
  AUDIT_EVENT_TYPES,
  REACTION_TOKENS,
  type Actor,
  type AuditEvent,
  type AuditEventType,
  type DraftAuditEvent,
} from "../domain/contracts";
import { canonicalStringify, sha256Hex } from "../domain/canonical";
import {
  applyAuditSemanticEvent,
  cloneAuditSemanticState,
  emptyAuditSemanticState,
  type AuditSemanticState,
} from "../domain/auditSemantics";

export const GENESIS_HASH = "0".repeat(64);

export type JournalFaultPhase =
  | "before_write"
  | "after_write_before_sync"
  | "after_sync_before_acknowledge";

export interface JournalFaultInjector {
  reach(phase: JournalFaultPhase, events: readonly AuditEvent[]): void | Promise<void>;
}

export interface DurableJournalOptions {
  readonly faultInjector?: JournalFaultInjector;
}

export class JournalCorruptionError extends Error {
  constructor(
    readonly journalPath: string,
    readonly byteOffset: number,
    readonly reasonCode: string,
  ) {
    super(`Journal recovery is required at byte ${byteOffset} (${reasonCode}). Original bytes were preserved.`);
    this.name = "JournalCorruptionError";
  }
}

export class JournalLockError extends Error {
  constructor(readonly journalPath: string) {
    super(`The journal already has a writer: ${journalPath}`);
    this.name = "JournalLockError";
  }
}

export class JournalUnavailableError extends Error {
  constructor(reasonCode: string) {
    super(`Journal cannot accept writes (${reasonCode}). Close and reopen it after inspection.`);
    this.name = "JournalUnavailableError";
  }
}

export class JournalCommitGuardError extends Error {
  constructor() {
    super("Journal commit was retired before its linearization point.");
    this.name = "JournalCommitGuardError";
  }
}

const EVENT_TYPE_SET = new Set<string>(AUDIT_EVENT_TYPES);
const TOP_LEVEL_KEYS = new Set([
  "eventId",
  "globalSequence",
  "workspaceId",
  "conversationId",
  "actor",
  "timestamp",
  "payloadSchemaVersion",
  "type",
  "payload",
  "previousHash",
  "currentHash",
]);
const DRAFT_KEYS = new Set([
  "eventId",
  "workspaceId",
  "conversationId",
  "actor",
  "timestamp",
  "payloadSchemaVersion",
  "type",
  "payload",
]);

const PAYLOAD_KEYS: Readonly<Record<AuditEventType, readonly string[]>> = {
  "workspace.created": ["name", "createdAt"],
  "conversation.created": ["title", "createdAt"],
  "conversation.title.changed": ["title"],
  "message.reaction.changed": ["messageId", "reaction", "enabled"],
  "agent.status.changed": ["agentId", "status"],
  "agent.profile.created": [
    "agentId",
    "clientRequestId",
    "displayName",
    "roleTitle",
    "colorToken",
    "markToken",
    "status",
    "createdAt",
    "updatedAt",
    "revision",
  ],
  "agent.profile.updated": [
    "agentId",
    "clientRequestId",
    "expectedRevision",
    "displayName",
    "roleTitle",
    "colorToken",
    "markToken",
    "status",
    "updatedAt",
    "revision",
  ],
  "section.created": [
    "sectionId",
    "clientRequestId",
    "name",
    "orderKey",
    "createdAt",
    "updatedAt",
    "revision",
  ],
  "section.renamed": [
    "sectionId",
    "clientRequestId",
    "expectedRevision",
    "name",
    "updatedAt",
    "revision",
  ],
  "section.reordered": [
    "sectionId",
    "clientRequestId",
    "expectedRevision",
    "orderKey",
    "updatedAt",
    "revision",
  ],
  "section.deleted": [
    "sectionId",
    "clientRequestId",
    "expectedRevision",
    "revision",
    "unassignedAgentIds",
    "deletedAt",
  ],
  "agent.section.changed": [
    "agentId",
    "clientRequestId",
    "expectedRevision",
    "previousSectionId",
    "sectionId",
    "revision",
    "changedAt",
    "reason",
  ],
  "reaction.state.set": [
    "messageId",
    "humanActorId",
    "reactionToken",
    "present",
    "clientRequestId",
    "setAt",
  ],
  "user.message.accepted": ["messageId", "turnId", "clientRequestId", "content"],
  "provider.selected": [
    "turnId",
    "providerId",
    "modelId",
    "protocolRevision",
    "credentialBindingRevision",
    "providerRequestId",
    "fallbackIndex",
  ],
  "assistant.stream.started": ["streamId", "messageId", "turnId", "providerId"],
  "assistant.stream.advanced": ["streamId", "turnId", "delta", "costUnits"],
  "assistant.stream.completed": ["streamId", "turnId", "stopReason"],
  "assistant.stream.cancelled": ["streamId", "turnId", "preservedDeltaCount"],
  "tool.proposed": ["turnId", "proposal", "proposalFingerprint", "providerId"],
  "policy.decided": ["turnId", "proposalId", "decision"],
  "approval.granted": ["turnId", "grant"],
  "approval.denied": ["turnId", "proposalId", "reasonCode"],
  "approval.expired": ["turnId", "proposalId", "grantId"],
  "approval.consumed": ["turnId", "proposalId", "grantId"],
  "tool.execution.started": ["turnId", "proposalId", "idempotencyKey", "entryPath"],
  "tool.execution.succeeded": ["turnId", "receipt"],
  "tool.execution.failed": ["turnId", "receipt"],
  "tool.execution.uncertain": ["turnId", "receipt"],
  "turn.completed": ["turnId", "clientRequestId", "status"],
  "turn.failed": ["turnId", "clientRequestId", "reasonCode"],
  "human.control.requested": [
    "controlId",
    "controlKind",
    "turnId",
    "clientRequestId",
    "directionEpoch",
    "directionHash",
    "requestedAt",
  ],
  "direction.accepted": [
    "directionId",
    "turnId",
    "clientRequestId",
    "directionEpoch",
    "kind",
    "messageId",
    "contentHash",
    "acceptedAt",
  ],
  "turn.stopped": [
    "controlId",
    "turnId",
    "clientRequestId",
    "directionEpoch",
    "reasonCode",
    "stoppedAt",
  ],
  "turn.steered": [
    "controlId",
    "turnId",
    "clientRequestId",
    "retiredDirectionEpoch",
    "nextDirectionEpoch",
    "directionId",
    "steeredAt",
  ],
};

const LEGACY_PROVIDER_SELECTED_KEYS = ["turnId", "providerId", "modelId", "fallbackIndex"] as const;

const OPTIONAL_PAYLOAD_KEYS: Readonly<Partial<Record<AuditEventType, readonly string[]>>> = {
  "provider.selected": ["directionEpoch"],
  "assistant.stream.started": ["directionEpoch"],
  "assistant.stream.advanced": ["directionEpoch"],
  "assistant.stream.completed": ["costUnits", "directionEpoch"],
  "assistant.stream.cancelled": ["directionEpoch"],
  "direction.accepted": ["requestHash"],
};

const WORKSPACE_SCOPED_EVENT_TYPES = new Set<AuditEventType>([
  "workspace.created",
  "agent.profile.created",
  "agent.profile.updated",
  "section.created",
  "section.renamed",
  "section.reordered",
  "section.deleted",
  "agent.section.changed",
]);

const HUMAN_ACTOR_EVENT_TYPES = new Set<AuditEventType>([
  "agent.profile.created",
  "agent.profile.updated",
  "section.created",
  "section.renamed",
  "section.reordered",
  "section.deleted",
  "reaction.state.set",
  "human.control.requested",
  "direction.accepted",
]);

const SYSTEM_ACTOR_EVENT_TYPES = new Set<AuditEventType>([
  "turn.stopped",
  "turn.steered",
]);

const STRICT_ACTOR_EVENT_TYPES = new Set<AuditEventType>([
  ...HUMAN_ACTOR_EVENT_TYPES,
  ...SYSTEM_ACTOR_EVENT_TYPES,
  "agent.section.changed",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isActor(value: unknown): value is Actor {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["kind", "id", "label"].includes(key))) return false;
  return (
    ["human", "agent", "system", "provider", "tool"].includes(String(value.kind)) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.label === undefined || typeof value.label === "string")
  );
}

function payloadHasExactKeys(
  type: AuditEventType,
  payload: Record<string, unknown>,
  payloadSchemaVersion: number,
): boolean {
  const required = type === "provider.selected" && payloadSchemaVersion === 1
    ? LEGACY_PROVIDER_SELECTED_KEYS
    : PAYLOAD_KEYS[type];
  const optional = OPTIONAL_PAYLOAD_KEYS[type] ?? [];
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(payload);
  return required.every((key) => Object.hasOwn(payload, key)) && actual.every((key) => allowed.has(key));
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EFFECTS = new Set([
  "pure_compute",
  "external_read",
  "write",
  "delete",
  "message",
  "credential",
  "purchase",
  "financial",
  "local_execution",
  "unknown",
]);
const AGENT_COLOR_TOKEN_SET = new Set<string>(AGENT_COLOR_TOKENS);
const AGENT_MARK_TOKEN_SET = new Set<string>(AGENT_MARK_TOKENS);
const AGENT_STATUS_SET = new Set<string>(AGENT_STATUSES);
const REACTION_TOKEN_SET = new Set<string>(REACTION_TOKENS);

const MAX_IDENTIFIER_LENGTH = 160;
const MAX_CLIENT_REQUEST_ID_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_ROLE_TITLE_LENGTH = 120;
const MAX_SECTION_NAME_LENGTH = 80;
const MAX_UNASSIGNED_AGENTS_PER_EVENT = 10_000;
const MAX_SECTION_ORDER_KEY = 1_000_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedIdentifier(value: unknown, maximum = MAX_IDENTIFIER_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isBoundedHumanText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isClientRequestId(value: unknown): value is string {
  return isBoundedIdentifier(value, MAX_CLIENT_REQUEST_ID_LENGTH);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasValidOptionalDirectionEpoch(payload: Record<string, unknown>): boolean {
  return payload.directionEpoch === undefined || isPositiveInteger(payload.directionEpoch);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isBoundedIdentifier(value);
}

function isUniqueIdentifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_UNASSIGNED_AGENTS_PER_EVENT &&
    value.every((item) => isBoundedIdentifier(item)) &&
    new Set(value).size === value.length
  );
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function hasExactObjectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key));
}

function isToolManifest(value: unknown): value is Record<string, unknown> {
  const required = [
    "toolId",
    "version",
    "schemaHash",
    "effect",
    "dataScope",
    "networkScope",
    "idempotency",
  ];
  if (!hasExactObjectKeys(value, required, ["allowPureComputation"])) return false;
  return (
    isNonEmptyString(value.toolId) &&
    isNonEmptyString(value.version) &&
    isHash(value.schemaHash) &&
    typeof value.effect === "string" &&
    EFFECTS.has(value.effect) &&
    isStringArray(value.dataScope) &&
    isStringArray(value.networkScope) &&
    ["idempotent", "non_idempotent"].includes(String(value.idempotency)) &&
    (value.allowPureComputation === undefined || typeof value.allowPureComputation === "boolean")
  );
}

function isAuditedProposal(value: unknown): value is Record<string, unknown> {
  const keys = [
    "proposalId",
    "workspaceId",
    "conversationId",
    "turnId",
    "actor",
    "manifest",
    "argumentsHash",
    "targetScope",
    "summary",
    "preparedAt",
  ];
  if (!hasExactObjectKeys(value, keys, ["directionEpoch"])) return false;
  return (
    isNonEmptyString(value.proposalId) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.conversationId) &&
    isNonEmptyString(value.turnId) &&
    (value.directionEpoch === undefined || isPositiveInteger(value.directionEpoch)) &&
    isActor(value.actor) &&
    isToolManifest(value.manifest) &&
    isHash(value.argumentsHash) &&
    isStringArray(value.targetScope) &&
    typeof value.summary === "string" &&
    isIsoTimestamp(value.preparedAt)
  );
}

function isPolicyDecision(value: unknown): value is Record<string, unknown> {
  if (!hasExactObjectKeys(value, ["outcome", "policyVersion", "reasonCode", "decidedAt"])) return false;
  return (
    ["allow", "ask", "deny"].includes(String(value.outcome)) &&
    isNonEmptyString(value.policyVersion) &&
    isNonEmptyString(value.reasonCode) &&
    isIsoTimestamp(value.decidedAt)
  );
}

function isApprovalGrant(value: unknown): value is Record<string, unknown> {
  const keys = [
    "grantId",
    "proposalFingerprint",
    "principalId",
    "proposingActorId",
    "workspaceId",
    "conversationId",
    "turnId",
    "stableToolId",
    "toolSchemaHash",
    "argumentsHash",
    "targetScope",
    "policyVersion",
    "grantedAt",
    "expiresAt",
    "nonce",
    "maximumUseCount",
  ];
  if (!hasExactObjectKeys(value, keys, ["directionEpoch"])) return false;
  const grantedAt = typeof value.grantedAt === "string" ? Date.parse(value.grantedAt) : Number.NaN;
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  return (
    isNonEmptyString(value.grantId) &&
    isHash(value.proposalFingerprint) &&
    isNonEmptyString(value.principalId) &&
    isNonEmptyString(value.proposingActorId) &&
    value.principalId !== value.proposingActorId &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.conversationId) &&
    isNonEmptyString(value.turnId) &&
    (value.directionEpoch === undefined || isPositiveInteger(value.directionEpoch)) &&
    isNonEmptyString(value.stableToolId) &&
    isHash(value.toolSchemaHash) &&
    isHash(value.argumentsHash) &&
    isStringArray(value.targetScope) &&
    isNonEmptyString(value.policyVersion) &&
    isIsoTimestamp(value.grantedAt) &&
    isIsoTimestamp(value.expiresAt) &&
    expiresAt > grantedAt &&
    expiresAt - grantedAt <= 5 * 60 * 1_000 &&
    isNonEmptyString(value.nonce) &&
    value.maximumUseCount === 1
  );
}

function isExecutionReceipt(
  value: unknown,
  expectedOutcome: "succeeded" | "failed" | "outcome_unknown",
): value is Record<string, unknown> {
  const keys = [
    "receiptId",
    "proposalId",
    "idempotencyKey",
    "outcome",
    "outputSummary",
    "startedAt",
    "finishedAt",
  ];
  if (!hasExactObjectKeys(value, keys)) return false;
  const startedAt = typeof value.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN;
  const finishedAt = typeof value.finishedAt === "string" ? Date.parse(value.finishedAt) : Number.NaN;
  return (
    isNonEmptyString(value.receiptId) &&
    isNonEmptyString(value.proposalId) &&
    isHash(value.idempotencyKey) &&
    value.outcome === expectedOutcome &&
    typeof value.outputSummary === "string" &&
    isIsoTimestamp(value.startedAt) &&
    isIsoTimestamp(value.finishedAt) &&
    finishedAt >= startedAt
  );
}

function payloadShapeIsValid(
  type: AuditEventType,
  payload: Record<string, unknown>,
  payloadSchemaVersion = 1,
): boolean {
  const strings = (...keys: readonly string[]) => keys.every((key) => isNonEmptyString(payload[key]));
  switch (type) {
    case "workspace.created":
      return strings("name") && isIsoTimestamp(payload.createdAt);
    case "conversation.created":
      return strings("title") && isIsoTimestamp(payload.createdAt);
    case "conversation.title.changed":
      return strings("title");
    case "message.reaction.changed":
      return strings("messageId", "reaction") && typeof payload.enabled === "boolean";
    case "agent.status.changed":
      return strings("agentId", "status");
    case "agent.profile.created":
      return (
        isBoundedIdentifier(payload.agentId) &&
        isClientRequestId(payload.clientRequestId) &&
        isBoundedHumanText(payload.displayName, MAX_DISPLAY_NAME_LENGTH) &&
        isBoundedHumanText(payload.roleTitle, MAX_ROLE_TITLE_LENGTH) &&
        typeof payload.colorToken === "string" &&
        AGENT_COLOR_TOKEN_SET.has(payload.colorToken) &&
        typeof payload.markToken === "string" &&
        AGENT_MARK_TOKEN_SET.has(payload.markToken) &&
        typeof payload.status === "string" &&
        AGENT_STATUS_SET.has(payload.status) &&
        isIsoTimestamp(payload.createdAt) &&
        payload.updatedAt === payload.createdAt &&
        payload.revision === 1
      );
    case "agent.profile.updated":
      return (
        isBoundedIdentifier(payload.agentId) &&
        isClientRequestId(payload.clientRequestId) &&
        isNonNegativeInteger(payload.expectedRevision) &&
        isPositiveInteger(payload.revision) &&
        payload.revision === Number(payload.expectedRevision) + 1 &&
        isBoundedHumanText(payload.displayName, MAX_DISPLAY_NAME_LENGTH) &&
        isBoundedHumanText(payload.roleTitle, MAX_ROLE_TITLE_LENGTH) &&
        typeof payload.colorToken === "string" &&
        AGENT_COLOR_TOKEN_SET.has(payload.colorToken) &&
        typeof payload.markToken === "string" &&
        AGENT_MARK_TOKEN_SET.has(payload.markToken) &&
        typeof payload.status === "string" &&
        AGENT_STATUS_SET.has(payload.status) &&
        isIsoTimestamp(payload.updatedAt)
      );
    case "section.created":
      return (
        isBoundedIdentifier(payload.sectionId) &&
        isClientRequestId(payload.clientRequestId) &&
        isBoundedHumanText(payload.name, MAX_SECTION_NAME_LENGTH) &&
        isNonNegativeInteger(payload.orderKey) &&
        Number(payload.orderKey) <= MAX_SECTION_ORDER_KEY &&
        isIsoTimestamp(payload.createdAt) &&
        payload.updatedAt === payload.createdAt &&
        payload.revision === 1
      );
    case "section.renamed":
      return (
        isBoundedIdentifier(payload.sectionId) &&
        isClientRequestId(payload.clientRequestId) &&
        isNonNegativeInteger(payload.expectedRevision) &&
        isPositiveInteger(payload.revision) &&
        payload.revision === Number(payload.expectedRevision) + 1 &&
        isBoundedHumanText(payload.name, MAX_SECTION_NAME_LENGTH) &&
        isIsoTimestamp(payload.updatedAt)
      );
    case "section.reordered":
      return (
        isBoundedIdentifier(payload.sectionId) &&
        isClientRequestId(payload.clientRequestId) &&
        isNonNegativeInteger(payload.expectedRevision) &&
        isPositiveInteger(payload.revision) &&
        payload.revision === Number(payload.expectedRevision) + 1 &&
        isNonNegativeInteger(payload.orderKey) &&
        Number(payload.orderKey) <= MAX_SECTION_ORDER_KEY &&
        isIsoTimestamp(payload.updatedAt)
      );
    case "section.deleted":
      return (
        isBoundedIdentifier(payload.sectionId) &&
        isClientRequestId(payload.clientRequestId) &&
        isNonNegativeInteger(payload.expectedRevision) &&
        isPositiveInteger(payload.revision) &&
        payload.revision === Number(payload.expectedRevision) + 1 &&
        isUniqueIdentifierArray(payload.unassignedAgentIds) &&
        isIsoTimestamp(payload.deletedAt)
      );
    case "agent.section.changed": {
      const actorIndependentShape =
        isBoundedIdentifier(payload.agentId) &&
        isClientRequestId(payload.clientRequestId) &&
        isNonNegativeInteger(payload.expectedRevision) &&
        isPositiveInteger(payload.revision) &&
        payload.revision === Number(payload.expectedRevision) + 1 &&
        isNullableIdentifier(payload.previousSectionId) &&
        isNullableIdentifier(payload.sectionId) &&
        isIsoTimestamp(payload.changedAt);
      if (!actorIndependentShape) return false;
      if (payload.reason === "section_deleted") {
        return payload.previousSectionId !== null && payload.sectionId === null;
      }
      return payload.reason === "user_assignment";
    }
    case "reaction.state.set":
      return (
        isBoundedIdentifier(payload.messageId) &&
        isBoundedIdentifier(payload.humanActorId) &&
        typeof payload.reactionToken === "string" &&
        REACTION_TOKEN_SET.has(payload.reactionToken) &&
        typeof payload.present === "boolean" &&
        isClientRequestId(payload.clientRequestId) &&
        isIsoTimestamp(payload.setAt)
      );
    case "user.message.accepted":
      return strings("messageId", "turnId", "clientRequestId") && typeof payload.content === "string";
    case "provider.selected":
      if (payloadSchemaVersion === 1) {
        return (
          strings("turnId", "providerId", "modelId") &&
          isNonNegativeInteger(payload.fallbackIndex) &&
          hasValidOptionalDirectionEpoch(payload)
        );
      }
      return (
        strings(
          "turnId",
          "providerId",
          "modelId",
          "protocolRevision",
          "credentialBindingRevision",
          "providerRequestId",
        ) &&
        /^bind_[A-Za-z0-9_-]{16,96}$/.test(String(payload.credentialBindingRevision)) &&
        /^prv_[A-Za-z0-9_-]{16,128}$/.test(String(payload.providerRequestId)) &&
        isNonNegativeInteger(payload.fallbackIndex) &&
        hasValidOptionalDirectionEpoch(payload)
      );
    case "assistant.stream.started":
      return strings("streamId", "messageId", "turnId", "providerId") && hasValidOptionalDirectionEpoch(payload);
    case "assistant.stream.advanced":
      return (
        strings("streamId", "turnId") &&
        typeof payload.delta === "string" &&
        isNonNegativeFinite(payload.costUnits) &&
        hasValidOptionalDirectionEpoch(payload)
      );
    case "assistant.stream.completed":
      return (
        strings("streamId", "turnId") &&
        ["complete", "tool_pause"].includes(String(payload.stopReason)) &&
        (payload.costUnits === undefined || isNonNegativeFinite(payload.costUnits)) &&
        hasValidOptionalDirectionEpoch(payload)
      );
    case "assistant.stream.cancelled":
      return (
        strings("streamId", "turnId") &&
        isNonNegativeInteger(payload.preservedDeltaCount) &&
        hasValidOptionalDirectionEpoch(payload)
      );
    case "tool.proposed":
      return (
        strings("turnId", "providerId") &&
        isAuditedProposal(payload.proposal) &&
        isHash(payload.proposalFingerprint) &&
        payload.turnId === payload.proposal.turnId
      );
    case "policy.decided":
      return strings("turnId", "proposalId") && isPolicyDecision(payload.decision);
    case "approval.granted":
      return strings("turnId") && isApprovalGrant(payload.grant) && payload.turnId === payload.grant.turnId;
    case "approval.denied":
      return strings("turnId", "proposalId", "reasonCode");
    case "approval.expired":
    case "approval.consumed":
      return strings("turnId", "proposalId", "grantId");
    case "tool.execution.started":
      return (
        strings("turnId", "proposalId") &&
        isHash(payload.idempotencyKey) &&
        ["direct", "routed", "retry", "resume"].includes(String(payload.entryPath))
      );
    case "tool.execution.succeeded":
      return strings("turnId") && isExecutionReceipt(payload.receipt, "succeeded");
    case "tool.execution.failed":
      return strings("turnId") && isExecutionReceipt(payload.receipt, "failed");
    case "tool.execution.uncertain":
      return strings("turnId") && isExecutionReceipt(payload.receipt, "outcome_unknown");
    case "turn.completed":
      return strings("turnId", "clientRequestId") && ["completed", "paused", "denied"].includes(String(payload.status));
    case "turn.failed":
      return strings("turnId", "clientRequestId", "reasonCode");
    case "human.control.requested":
      return (
        isBoundedIdentifier(payload.controlId) &&
        ["stop", "steer"].includes(String(payload.controlKind)) &&
        isBoundedIdentifier(payload.turnId) &&
        isClientRequestId(payload.clientRequestId) &&
        isPositiveInteger(payload.directionEpoch) &&
        isHash(payload.directionHash) &&
        isIsoTimestamp(payload.requestedAt)
      );
    case "direction.accepted":
      return (
        isBoundedIdentifier(payload.directionId) &&
        isBoundedIdentifier(payload.turnId) &&
        isClientRequestId(payload.clientRequestId) &&
        isPositiveInteger(payload.directionEpoch) &&
        ["initial", "steer", "follow_up"].includes(String(payload.kind)) &&
        isBoundedIdentifier(payload.messageId) &&
        isHash(payload.contentHash) &&
        (payload.requestHash === undefined || isHash(payload.requestHash)) &&
        isIsoTimestamp(payload.acceptedAt)
      );
    case "turn.stopped":
      return (
        isBoundedIdentifier(payload.controlId) &&
        isBoundedIdentifier(payload.turnId) &&
        isClientRequestId(payload.clientRequestId) &&
        isPositiveInteger(payload.directionEpoch) &&
        payload.reasonCode === "human_stop" &&
        isIsoTimestamp(payload.stoppedAt)
      );
    case "turn.steered":
      return (
        isBoundedIdentifier(payload.controlId) &&
        isBoundedIdentifier(payload.turnId) &&
        isClientRequestId(payload.clientRequestId) &&
        isPositiveInteger(payload.retiredDirectionEpoch) &&
        payload.nextDirectionEpoch === Number(payload.retiredDirectionEpoch) + 1 &&
        isBoundedIdentifier(payload.directionId) &&
        isIsoTimestamp(payload.steeredAt)
      );
  }
}

function payloadMatchesEnvelope(
  type: AuditEventType,
  payload: Record<string, unknown>,
  workspaceId: unknown,
  conversationId: unknown,
  actor: Actor,
): boolean {
  if (type === "tool.proposed" && isPlainObject(payload.proposal)) {
    return payload.proposal.workspaceId === workspaceId && payload.proposal.conversationId === conversationId;
  }
  if (type === "approval.granted" && isPlainObject(payload.grant)) {
    return payload.grant.workspaceId === workspaceId && payload.grant.conversationId === conversationId;
  }
  if (type === "reaction.state.set" && payload.humanActorId !== actor.id) return false;
  return true;
}

function eventScopeIsValid(type: AuditEventType, conversationId: unknown): boolean {
  return WORKSPACE_SCOPED_EVENT_TYPES.has(type)
    ? conversationId === undefined
    : typeof conversationId === "string" && conversationId.length > 0;
}

function eventActorIsValid(
  type: AuditEventType,
  payload: Record<string, unknown>,
  actor: Actor,
): boolean {
  if (
    STRICT_ACTOR_EVENT_TYPES.has(type) &&
    (!isBoundedIdentifier(actor.id) ||
      (actor.label !== undefined && !isBoundedHumanText(actor.label, MAX_DISPLAY_NAME_LENGTH)))
  ) {
    return false;
  }
  if (HUMAN_ACTOR_EVENT_TYPES.has(type)) return actor.kind === "human";
  if (SYSTEM_ACTOR_EVENT_TYPES.has(type)) return actor.kind === "system";
  if (type === "agent.section.changed") {
    return payload.reason === "section_deleted" ? actor.kind === "system" : actor.kind === "human";
  }
  return true;
}

function assertDraftShape(value: unknown): asserts value is DraftAuditEvent {
  if (!isPlainObject(value)) throw new JournalUnavailableError("draft_not_object");
  if (Object.keys(value).some((key) => !DRAFT_KEYS.has(key))) {
    throw new JournalUnavailableError("unexpected_draft_field");
  }
  if (typeof value.eventId !== "string" || value.eventId.length === 0) {
    throw new JournalUnavailableError("invalid_draft_event_id");
  }
  if (typeof value.workspaceId !== "string" || value.workspaceId.length === 0) {
    throw new JournalUnavailableError("invalid_draft_workspace_id");
  }
  if (value.conversationId !== undefined && typeof value.conversationId !== "string") {
    throw new JournalUnavailableError("invalid_draft_conversation_id");
  }
  if (!isActor(value.actor)) throw new JournalUnavailableError("invalid_draft_actor");
  if (!isIsoTimestamp(value.timestamp)) {
    throw new JournalUnavailableError("invalid_draft_timestamp");
  }
  if (value.type === "provider.selected"
    ? value.payloadSchemaVersion !== 2
    : value.payloadSchemaVersion !== 1) {
    throw new JournalUnavailableError("invalid_draft_schema_version");
  }
  if (typeof value.type !== "string" || !EVENT_TYPE_SET.has(value.type)) {
    throw new JournalUnavailableError("invalid_draft_event_type");
  }
  if (!isPlainObject(value.payload)) throw new JournalUnavailableError("invalid_draft_payload");
  if (!payloadHasExactKeys(value.type as AuditEventType, value.payload, Number(value.payloadSchemaVersion))) {
    throw new JournalUnavailableError("invalid_draft_payload_fields");
  }
  if (!payloadShapeIsValid(value.type as AuditEventType, value.payload, Number(value.payloadSchemaVersion))) {
    throw new JournalUnavailableError("invalid_draft_payload_shape");
  }
  if (!eventActorIsValid(value.type as AuditEventType, value.payload, value.actor)) {
    throw new JournalUnavailableError("invalid_draft_event_actor");
  }
  if (!payloadMatchesEnvelope(
    value.type as AuditEventType,
    value.payload,
    value.workspaceId,
    value.conversationId,
    value.actor,
  )) {
    throw new JournalUnavailableError("draft_payload_envelope_mismatch");
  }
  if (!eventScopeIsValid(value.type as AuditEventType, value.conversationId)) {
    throw new JournalUnavailableError("invalid_draft_event_scope");
  }
  try {
    canonicalStringify(value);
  } catch {
    throw new JournalUnavailableError("draft_not_canonicalizable");
  }
}

function assertEventShape(value: unknown, path: string, byteOffset: number): asserts value is AuditEvent {
  const corrupt = (reasonCode: string): never => {
    throw new JournalCorruptionError(path, byteOffset, reasonCode);
  };

  if (!isPlainObject(value)) throw new JournalCorruptionError(path, byteOffset, "record_not_object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !TOP_LEVEL_KEYS.has(key))) corrupt("unexpected_record_field");
  if (typeof record.eventId !== "string" || record.eventId.length === 0) corrupt("invalid_event_id");
  if (!Number.isSafeInteger(record.globalSequence) || Number(record.globalSequence) < 1) {
    corrupt("invalid_global_sequence");
  }
  if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) {
    corrupt("invalid_workspace_id");
  }
  if (record.conversationId !== undefined && typeof record.conversationId !== "string") {
    corrupt("invalid_conversation_id");
  }
  const actor = record.actor;
  if (!isActor(actor)) corrupt("invalid_actor");
  const validatedActor = actor as Actor;
  if (!isIsoTimestamp(record.timestamp)) {
    corrupt("invalid_timestamp");
  }
  const replaySchemaAllowed = record.type === "provider.selected"
    ? record.payloadSchemaVersion === 1 || record.payloadSchemaVersion === 2
    : record.payloadSchemaVersion === 1;
  if (!replaySchemaAllowed) corrupt("unsupported_payload_schema");
  if (typeof record.type !== "string" || !EVENT_TYPE_SET.has(record.type)) corrupt("unknown_event_type");
  if (!isPlainObject(record.payload)) corrupt("invalid_event_payload");
  if (!payloadHasExactKeys(
    record.type as AuditEventType,
    record.payload as Record<string, unknown>,
    record.payloadSchemaVersion as number,
  )) {
    corrupt("invalid_event_payload_fields");
  }
  if (!payloadShapeIsValid(
    record.type as AuditEventType,
    record.payload as Record<string, unknown>,
    record.payloadSchemaVersion as number,
  )) {
    corrupt("invalid_event_payload_shape");
  }
  if (!eventActorIsValid(
    record.type as AuditEventType,
    record.payload as Record<string, unknown>,
    validatedActor,
  )) {
    corrupt("invalid_event_actor");
  }
  if (!payloadMatchesEnvelope(
    record.type as AuditEventType,
    record.payload as Record<string, unknown>,
    record.workspaceId,
    record.conversationId,
    validatedActor,
  )) {
    corrupt("event_payload_envelope_mismatch");
  }
  if (!eventScopeIsValid(record.type as AuditEventType, record.conversationId)) {
    corrupt("invalid_event_scope");
  }
  if (!isHash(record.previousHash)) {
    corrupt("invalid_previous_hash");
  }
  if (!isHash(record.currentHash)) {
    corrupt("invalid_current_hash");
  }
}

function withoutCurrentHash(event: AuditEvent): Omit<AuditEvent, "currentHash"> {
  const { currentHash: _ignored, ...hashInput } = event;
  return hashInput;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

function snapshotDraftBatch(value: unknown): readonly DraftAuditEvent[] {
  let isBatch = false;
  try {
    isBatch = Array.isArray(value);
  } catch {
    throw new JournalUnavailableError("draft_not_canonicalizable");
  }
  if (!isBatch) {
    throw new JournalUnavailableError("draft_batch_not_array");
  }

  let cloned: unknown;
  try {
    cloned = canonicalClone(value);
  } catch {
    throw new JournalUnavailableError("draft_not_canonicalizable");
  }

  if (!Array.isArray(cloned)) {
    throw new JournalUnavailableError("draft_batch_not_array");
  }
  for (const draft of cloned) assertDraftShape(draft);
  return deepFreeze(cloned as DraftAuditEvent[]);
}

function frameEvent(draft: DraftAuditEvent, sequence: number, previousHash: string): AuditEvent {
  const clonedDraft = canonicalClone(draft);
  const hashInput = {
    ...clonedDraft,
    globalSequence: sequence,
    previousHash,
  } as Omit<AuditEvent, "currentHash">;

  return deepFreeze({
    ...hashInput,
    currentHash: sha256Hex(canonicalStringify(hashInput)),
  } as AuditEvent);
}

interface StreamEpochBinding {
  readonly turnId: string;
  readonly directionEpoch?: number;
}

interface EpochLifecycleState {
  readonly retired: Set<string>;
  readonly streams: Map<string, StreamEpochBinding>;
  readonly proposals: Map<string, StreamEpochBinding>;
}

function emptyEpochLifecycleState(): EpochLifecycleState {
  return { retired: new Set(), streams: new Map(), proposals: new Map() };
}

function cloneEpochLifecycleState(state: EpochLifecycleState): EpochLifecycleState {
  return {
    retired: new Set(state.retired),
    streams: new Map(state.streams),
    proposals: new Map(state.proposals),
  };
}

function directionEpochKey(event: AuditEvent, turnId: unknown, directionEpoch: unknown): string {
  return canonicalStringify([
    event.workspaceId,
    event.conversationId ?? null,
    turnId,
    directionEpoch,
  ]);
}

function streamEpochKey(event: AuditEvent, streamId: unknown): string {
  return canonicalStringify([event.workspaceId, event.conversationId ?? null, streamId]);
}

function proposalEpochKey(event: AuditEvent, proposalId: unknown): string {
  return canonicalStringify([event.workspaceId, event.conversationId ?? null, proposalId]);
}

function applyEpochLifecycle(
  state: EpochLifecycleState,
  event: AuditEvent,
  fail: (reasonCode: string) => never,
): void {
  const payload = event.payload as Record<string, unknown>;

  if (event.type === "human.control.requested" || event.type === "turn.stopped") {
    state.retired.add(directionEpochKey(event, payload.turnId, payload.directionEpoch));
    return;
  }
  if (event.type === "turn.steered") {
    state.retired.add(directionEpochKey(event, payload.turnId, payload.retiredDirectionEpoch));
    return;
  }

  if (event.type === "tool.proposed") {
    const proposal = payload.proposal as Record<string, unknown>;
    const directionEpoch = proposal.directionEpoch as number | undefined;
    if (
      directionEpoch !== undefined &&
      state.retired.has(directionEpochKey(event, payload.turnId, directionEpoch))
    ) {
      fail("retired_direction_epoch");
    }
    state.proposals.set(proposalEpochKey(event, proposal.proposalId), {
      turnId: String(payload.turnId),
      directionEpoch,
    });
    return;
  }

  if (
    event.type === "approval.granted" ||
    event.type === "approval.consumed" ||
    event.type === "tool.execution.started"
  ) {
    const proposalId = event.type === "approval.granted"
      ? (payload.grant as Record<string, unknown>).proposalFingerprint
      : payload.proposalId;
    const binding = event.type === "approval.granted"
      ? [...state.proposals.values()].find((candidate) =>
          candidate.turnId === payload.turnId &&
          candidate.directionEpoch === (payload.grant as Record<string, unknown>).directionEpoch
        )
      : state.proposals.get(proposalEpochKey(event, proposalId));
    if (
      binding?.directionEpoch !== undefined &&
      state.retired.has(directionEpochKey(event, binding.turnId, binding.directionEpoch))
    ) {
      fail("retired_direction_epoch");
    }
    return;
  }

  if (event.type === "assistant.stream.started") {
    const key = streamEpochKey(event, payload.streamId);
    const existing = state.streams.get(key);
    const directionEpoch = payload.directionEpoch as number | undefined;
    if (existing && existing.turnId !== payload.turnId) fail("stream_turn_mismatch");
    if (
      existing?.directionEpoch !== undefined &&
      directionEpoch !== undefined &&
      existing.directionEpoch !== directionEpoch
    ) {
      fail("stream_direction_epoch_mismatch");
    }
    if (
      directionEpoch !== undefined &&
      state.retired.has(directionEpochKey(event, payload.turnId, directionEpoch))
    ) {
      fail("retired_direction_epoch");
    }
    state.streams.set(key, {
      turnId: String(payload.turnId),
      directionEpoch: directionEpoch ?? existing?.directionEpoch,
    });
    return;
  }

  if (
    event.type !== "assistant.stream.advanced" &&
    event.type !== "assistant.stream.completed" &&
    event.type !== "assistant.stream.cancelled"
  ) {
    return;
  }

  const key = streamEpochKey(event, payload.streamId);
  const existing = state.streams.get(key);
  const explicitEpoch = payload.directionEpoch as number | undefined;
  if (existing && existing.turnId !== payload.turnId) fail("stream_turn_mismatch");
  if (
    existing?.directionEpoch !== undefined &&
    explicitEpoch !== undefined &&
    existing.directionEpoch !== explicitEpoch
  ) {
    fail("stream_direction_epoch_mismatch");
  }
  const effectiveEpoch = explicitEpoch ?? existing?.directionEpoch;
  if (existing && existing.directionEpoch === undefined && explicitEpoch !== undefined) {
    state.streams.set(key, { turnId: existing.turnId, directionEpoch: explicitEpoch });
  }
  if (
    event.type !== "assistant.stream.cancelled" &&
    effectiveEpoch !== undefined &&
    state.retired.has(directionEpochKey(event, payload.turnId, effectiveEpoch))
  ) {
    fail("retired_direction_epoch");
  }
}

function buildEpochLifecycleState(events: readonly AuditEvent[]): EpochLifecycleState {
  const state = emptyEpochLifecycleState();
  for (const event of events) {
    applyEpochLifecycle(state, event, (reasonCode) => {
      throw new Error(`Invalid in-memory epoch lifecycle (${reasonCode})`);
    });
  }
  return state;
}

export function replayJournalBytes(path: string, bytes: Uint8Array): readonly AuditEvent[] {
  if (bytes.byteLength === 0) return [];

  const text = new TextDecoder("utf-8", { fatal: true });
  let decoded: string;
  try {
    decoded = text.decode(bytes);
  } catch {
    throw new JournalCorruptionError(path, 0, "invalid_utf8");
  }

  if (!decoded.endsWith("\n")) {
    throw new JournalCorruptionError(path, bytes.byteLength, "truncated_frame");
  }

  const events: AuditEvent[] = [];
  const eventIds = new Set<string>();
  const epochState = emptyEpochLifecycleState();
  const semanticState = emptyAuditSemanticState();
  let expectedHash = GENESIS_HASH;
  let byteOffset = 0;
  const lines = decoded.slice(0, -1).split("\n");

  for (const line of lines) {
    if (line.length === 0) {
      throw new JournalCorruptionError(path, byteOffset, "empty_frame");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new JournalCorruptionError(path, byteOffset, "invalid_json");
    }

    assertEventShape(parsed, path, byteOffset);
    const expectedSequence = events.length + 1;
    if (parsed.globalSequence !== expectedSequence) {
      throw new JournalCorruptionError(path, byteOffset, "non_monotonic_sequence");
    }
    if (parsed.previousHash !== expectedHash) {
      throw new JournalCorruptionError(path, byteOffset, "broken_hash_chain");
    }
    if (eventIds.has(parsed.eventId)) {
      throw new JournalCorruptionError(path, byteOffset, "duplicate_event_id");
    }
    const computedHash = sha256Hex(canonicalStringify(withoutCurrentHash(parsed)));
    if (parsed.currentHash !== computedHash) {
      throw new JournalCorruptionError(path, byteOffset, "checksum_mismatch");
    }
    applyEpochLifecycle(epochState, parsed, (reasonCode) => {
      throw new JournalCorruptionError(path, byteOffset, reasonCode);
    });
    const semanticFailure = applyAuditSemanticEvent(semanticState, parsed);
    if (semanticFailure) {
      throw new JournalCorruptionError(path, byteOffset, semanticFailure);
    }

    events.push(deepFreeze(parsed));
    eventIds.add(parsed.eventId);
    expectedHash = parsed.currentHash;
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
  }

  return Object.freeze(events);
}

function buildAuditSemanticState(events: readonly AuditEvent[]): AuditSemanticState {
  const state = emptyAuditSemanticState();
  for (const event of events) {
    const failure = applyAuditSemanticEvent(state, event);
    if (failure) throw new Error(`Invalid in-memory audit semantics (${failure})`);
  }
  return state;
}

async function readExisting(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array();
    throw error;
  }
}

interface WriterLockRecord {
  readonly pid: number;
  readonly createdAt: string;
  readonly nonce: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

async function staleLockCanBeRemoved(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WriterLockRecord>;
    return Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0 && !processIsAlive(Number(parsed.pid));
  } catch {
    return false;
  }
}

async function acquireWriterLock(path: string, recoveryAttempted = false): Promise<FileHandle> {
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const record: WriterLockRecord = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    await handle.writeFile(`${canonicalStringify(record)}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (!recoveryAttempted && (await staleLockCanBeRemoved(path))) {
        await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        return acquireWriterLock(path, true);
      }
      throw new JournalLockError(path.slice(0, -".writer.lock".length));
    }
    throw error;
  }
}

export class DurableJournal {
  readonly path: string;
  readonly lockPath: string;
  private readonly faultInjector?: JournalFaultInjector;
  private readonly lockHandle: FileHandle;
  private records: AuditEvent[];
  private epochState: EpochLifecycleState;
  private semanticState: AuditSemanticState;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;

  private constructor(
    path: string,
    lockHandle: FileHandle,
    records: readonly AuditEvent[],
    options: DurableJournalOptions,
  ) {
    this.path = path;
    this.lockPath = `${path}.writer.lock`;
    this.lockHandle = lockHandle;
    this.records = [...records];
    this.epochState = buildEpochLifecycleState(records);
    this.semanticState = buildAuditSemanticState(records);
    this.faultInjector = options.faultInjector;
  }

  static async open(path: string, options: DurableJournalOptions = {}): Promise<DurableJournal> {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.writer.lock`;
    const lockHandle = await acquireWriterLock(lockPath);
    try {
      const bytes = await readExisting(path);
      const records = replayJournalBytes(path, bytes);
      return new DurableJournal(path, lockHandle, records, options);
    } catch (error) {
      await lockHandle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  snapshot(): readonly AuditEvent[] {
    return Object.freeze([...this.records]);
  }

  get nextSequence(): number {
    return this.records.length + 1;
  }

  append<Type extends AuditEventType>(draft: DraftAuditEvent<Type>): Promise<AuditEvent<Type>> {
    return this.appendBatch([draft]).then(([event]) => event as AuditEvent<Type>);
  }

  appendGuarded<Type extends AuditEventType>(
    draft: DraftAuditEvent<Type>,
    guard: () => boolean,
  ): Promise<AuditEvent<Type>> {
    return this.appendBatchGuarded([draft], guard).then(([event]) => event as AuditEvent<Type>);
  }

  appendBatch(drafts: readonly DraftAuditEvent[]): Promise<readonly AuditEvent[]> {
    return this.appendBatchGuarded(drafts, () => true);
  }

  appendBatchGuarded(
    drafts: readonly DraftAuditEvent[],
    guard: () => boolean,
  ): Promise<readonly AuditEvent[]> {
    let snapshot: readonly DraftAuditEvent[];
    try {
      snapshot = snapshotDraftBatch(drafts);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.enqueue(async () => {
      this.assertWritable();
      if (snapshot.length === 0) return [];

      const framed: AuditEvent[] = [];
      const nextEpochState = cloneEpochLifecycleState(this.epochState);
      const nextSemanticState = cloneAuditSemanticState(this.semanticState);
      const knownEventIds = new Set(this.records.map((event) => event.eventId));
      let previousHash = this.records.at(-1)?.currentHash ?? GENESIS_HASH;
      let sequence = this.records.length + 1;
      for (const draft of snapshot) {
        assertDraftShape(draft);
        if (knownEventIds.has(draft.eventId)) {
          throw new JournalUnavailableError("duplicate_event_id");
        }
        knownEventIds.add(draft.eventId);
        const event = frameEvent(draft, sequence, previousHash);
        applyEpochLifecycle(nextEpochState, event, (reasonCode) => {
          throw new JournalUnavailableError(reasonCode);
        });
        const semanticFailure = applyAuditSemanticEvent(nextSemanticState, event);
        if (semanticFailure) throw new JournalUnavailableError(semanticFailure);
        framed.push(event);
        sequence += 1;
        previousHash = event.currentHash;
      }

      await this.faultInjector?.reach("before_write", framed);
      let commitAllowed = false;
      try {
        commitAllowed = guard() === true;
      } catch {
        commitAllowed = false;
      }
      if (!commitAllowed) throw new JournalCommitGuardError();
      const handle = await open(this.path, "a", 0o600);
      let failure: unknown;
      try {
        const data = framed.map((event) => `${canonicalStringify(event)}\n`).join("");
        try {
          await handle.writeFile(data, "utf8");
          await this.faultInjector?.reach("after_write_before_sync", framed);
          await handle.sync();
        } catch (error) {
          failure = error;
          this.poisoned = true;
        }
      } finally {
        try {
          await handle.close();
        } catch (error) {
          this.poisoned = true;
          failure ??= error;
        }
      }
      if (failure) throw failure;

      this.records.push(...framed);
      this.epochState = nextEpochState;
      this.semanticState = nextSemanticState;
      try {
        await this.faultInjector?.reach("after_sync_before_acknowledge", framed);
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
      return Object.freeze(framed);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.lockHandle.close();
    await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private assertWritable(): void {
    if (this.closed) throw new JournalUnavailableError("closed");
    if (this.poisoned) throw new JournalUnavailableError("persistence_outcome_unknown");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
