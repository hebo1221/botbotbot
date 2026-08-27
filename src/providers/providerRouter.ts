import { randomUUID } from "node:crypto";
import { canonicalHash, canonicalStringify } from "../domain/canonical";
import {
  asId,
  type CredentialBindingRevision,
  type ProviderAdapter,
  type ProviderAuthoritySnapshot,
  type ProviderAttemptId,
  type ProviderCandidate,
  type ProviderCapability,
  type ProviderChunk,
  type ProviderId,
  type ProviderModelCapabilitySnapshot,
  type ProviderCredentialAudience,
  type ProviderRequestId,
  type ProviderSelection,
  type ProviderTurnRequest,
  type ReviewedProviderTool,
  type ReviewedToolAuthority,
} from "../domain/contracts";
import {
  addNativeAbortListener,
  consumeFallbackAttestation,
  isAuthenticCredentialBrokerError,
  nativeSignalAborted,
  removeNativeAbortListener,
  type CredentialBrokerErrorCode,
} from "./credentialBroker";
import {
  ProviderAdapterError,
  type ProviderAdapterErrorCode,
} from "./providerAdapterCommon";
import {
  ProviderHistoryValidationError,
  type ProviderHistoryValidationCode,
} from "./providerHistory";
import {
  ProviderStreamBoundaryError,
  type ProviderStreamBoundaryCode,
} from "./providerStream";
import {
  prepareReviewedTools,
  ReviewedToolError,
  type ReviewedToolErrorCode,
} from "./reviewedTools";

const KNOWN_CAPABILITIES = new Set<ProviderCapability>([
  "streaming",
  "tool_proposals",
  "image_input",
  "usage",
  "cancellation",
  "opaque_reasoning_round_trip",
]);

const CAPABILITY_FIELDS: Readonly<Record<ProviderCapability, keyof ProviderModelCapabilitySnapshot>> =
  Object.freeze({
    streaming: "streaming",
    tool_proposals: "toolProposals",
    image_input: "imageInput",
    usage: "usage",
    cancellation: "cancellation",
    opaque_reasoning_round_trip: "opaqueReasoningRoundTrip",
  });

const FALLBACK_BROKER_CODES = new Set<CredentialBrokerErrorCode>([
  "connect_failure_before_body",
  "http_retryable_before_stream",
]);

const PREFLIGHT_REASONS = new Set<ProviderPreflightReason>([
  "empty_selection", "unknown_capability", "duplicate_candidate", "unknown_provider", "unknown_model",
  "ineligible_primary", "ineligible_candidate", "duplicate_provider", "invalid_capability_document",
  "invalid_credential_binding", "invalid_reviewed_tools", "authority_changed",
]);
const TRANSPORT_CODES = new Set<TrustedProviderTransportCode>([
  "connect_failure_before_body", "http_retryable_before_stream", "outcome_unknown",
]);
const PROTOCOL_OUTPUT_CODES = new Set<ProviderProtocolOutputError["reasonCode"]>([
  "missing_terminal", "chunk_after_terminal", "invalid_usage",
]);
const ADAPTER_ERROR_CODES = new Set<ProviderAdapterErrorCode>([
  "invalid_adapter_configuration", "invalid_turn_request", "unsupported_model", "protocol_violation",
  "malformed_order", "duplicate_identity", "unknown_authority_event", "provider_error",
  "incomplete_response", "refusal", "multiple_tool_calls", "reasoning_round_trip_unavailable",
  "secret_reflection_blocked",
]);
const HISTORY_VALIDATION_CODES = new Set<ProviderHistoryValidationCode>([
  "empty_history", "invalid_history_record", "duplicate_history_id", "broken_history_alternation",
  "incomplete_tool_exchange", "cross_provider_tool_exchange", "history_too_large",
]);
const STREAM_BOUNDARY_CODES = new Set<ProviderStreamBoundaryCode>([
  "invalid_limits", "invalid_request_id", "event_line_too_large", "event_too_large", "response_too_large",
  "text_too_large", "too_many_events", "duration_exceeded", "idle_timeout", "malformed_sse",
  "malformed_utf8", "utf8_bom_forbidden", "malformed_json", "duplicate_json_key", "json_depth_exceeded",
  "request_cancelled", "upstream_stream_failure", "cleanup_failed", "secret_reflection_blocked",
  "tool_arguments_too_large", "tool_arguments_malformed", "invalid_provider_id", "invalid_usage",
]);
const REVIEWED_TOOL_CODES = new Set<ReviewedToolErrorCode>([
  "invalid_tool_definition", "tool_name_collision", "schema_hash_mismatch", "unsupported_schema",
  "invalid_tool_arguments", "unadvertised_tool",
]);

function allowlistedReason<Value extends string>(error: unknown, allowed: ReadonlySet<Value>): Value | undefined {
  try {
    const reason = (error as { readonly reasonCode?: unknown }).reasonCode;
    return typeof reason === "string" && allowed.has(reason as Value) ? reason as Value : undefined;
  } catch {
    return undefined;
  }
}

export type ProviderPreflightReason =
  | "empty_selection"
  | "unknown_capability"
  | "duplicate_candidate"
  | "unknown_provider"
  | "unknown_model"
  | "ineligible_primary"
  | "ineligible_candidate"
  | "duplicate_provider"
  | "invalid_capability_document"
  | "invalid_credential_binding"
  | "invalid_reviewed_tools"
  | "authority_changed";

export class ProviderPreflightError extends Error {
  readonly reasonCode: ProviderPreflightReason;

  constructor(reasonCodeValue: ProviderPreflightReason) {
    const reasonCode = PREFLIGHT_REASONS.has(reasonCodeValue)
      ? reasonCodeValue
      : "invalid_capability_document";
    super(`Provider preflight failed (${reasonCode}).`);
    this.name = "ProviderPreflightError";
    this.reasonCode = reasonCode;
    Object.freeze(this);
  }
}

export type TrustedProviderTransportCode =
  | "connect_failure_before_body"
  | "http_retryable_before_stream"
  | "outcome_unknown";

export class ProviderTransportError extends Error {
  readonly reasonCode: TrustedProviderTransportCode;
  readonly retryable: boolean;

  constructor(reasonCodeValue: TrustedProviderTransportCode) {
    const reasonCode = TRANSPORT_CODES.has(reasonCodeValue) ? reasonCodeValue : "outcome_unknown";
    super(`Provider transport stopped (${reasonCode}).`);
    this.name = "ProviderTransportError";
    this.reasonCode = reasonCode;
    this.retryable = reasonCode === "connect_failure_before_body" ||
      reasonCode === "http_retryable_before_stream";
    Object.freeze(this);
  }
}

export class ProviderFailureAfterOutputError extends Error {
  constructor(readonly providerId: ProviderId) {
    super(`Provider ${providerId} failed after visible output; fallback was stopped.`);
    this.name = "ProviderFailureAfterOutputError";
    Object.freeze(this);
  }
}

export class ProviderTurnCancelledError extends Error {
  constructor() {
    super("Provider turn was cancelled.");
    this.name = "ProviderTurnCancelledError";
    Object.freeze(this);
  }
}

export class ProviderRouterCleanupError extends Error {
  constructor() {
    super("Provider iterator cleanup did not complete within its safety bound.");
    this.name = "ProviderRouterCleanupError";
    Object.freeze(this);
  }
}

export class ProviderProtocolOutputError extends Error {
  readonly reasonCode: "missing_terminal" | "chunk_after_terminal" | "invalid_usage";

  constructor(reasonCodeValue: "missing_terminal" | "chunk_after_terminal" | "invalid_usage") {
    const reasonCode = PROTOCOL_OUTPUT_CODES.has(reasonCodeValue) ? reasonCodeValue : "missing_terminal";
    super(`Provider normalized output stopped (${reasonCode}).`);
    this.name = "ProviderProtocolOutputError";
    this.reasonCode = reasonCode;
    Object.freeze(this);
  }
}

export type RoutedProviderChunk =
  | {
      readonly kind: "provider_selected";
      readonly providerId: ProviderId;
      readonly modelId: string;
      readonly protocolRevision: string;
      readonly credentialBindingRevision: CredentialBindingRevision;
      readonly providerRequestId: ProviderRequestId;
      readonly fallbackIndex: number;
    }
  | {
      readonly kind: "provider_chunk";
      readonly providerId: ProviderId;
      readonly modelId: string;
      readonly chunk: Exclude<ProviderChunk, { readonly kind: "tool_proposal" }>;
    }
  | {
      readonly kind: "provider_chunk";
      readonly providerId: ProviderId;
      readonly modelId: string;
      readonly chunk: Extract<ProviderChunk, { readonly kind: "tool_proposal" }>;
      readonly reviewedToolAuthority: ReviewedToolAuthority;
    };

interface RegisteredProvider {
  readonly adapter: ProviderAdapter;
  readonly providerId: ProviderId;
  readonly credentialAudience: ProviderCredentialAudience;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly credentialBindingRevision: CredentialBindingRevision;
  readonly reviewedTools: readonly ReviewedProviderTool[];
}

export interface EligibleProvider {
  readonly registration: RegisteredProvider;
  readonly candidate: ProviderCandidate;
  readonly capability: ProviderModelCapabilitySnapshot;
  readonly fallbackIndex: number;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cloneCapability(value: unknown, providerId: ProviderId): ProviderModelCapabilitySnapshot {
  if (!plainRecord(value) || !exactKeys(value, [
    "providerId",
    "modelId",
    "protocolRevision",
    "streaming",
    "toolProposals",
    "imageInput",
    "usage",
    "cancellation",
    "opaqueReasoningRoundTrip",
  ]) || value.providerId !== providerId || typeof value.modelId !== "string" || !value.modelId ||
    typeof value.protocolRevision !== "string" || !value.protocolRevision ||
    !["streaming", "toolProposals", "imageInput", "usage", "cancellation", "opaqueReasoningRoundTrip"]
      .every((key) => typeof value[key] === "boolean")) {
    throw new ProviderPreflightError("invalid_capability_document");
  }
  return Object.freeze({
    providerId,
    modelId: value.modelId,
    protocolRevision: value.protocolRevision,
    streaming: value.streaming as boolean,
    toolProposals: value.toolProposals as boolean,
    imageInput: value.imageInput as boolean,
    usage: value.usage as boolean,
    cancellation: value.cancellation as boolean,
    opaqueReasoningRoundTrip: value.opaqueReasoningRoundTrip as boolean,
  });
}

function validAuthoritySnapshot(value: unknown): value is ProviderAuthoritySnapshot {
  return plainRecord(value) &&
    exactKeys(value, ["credentialAudience", "credentialBindingRevision"]) &&
    typeof value.credentialAudience === "string" &&
    ["openai", "anthropic", "openrouter"].includes(value.credentialAudience) &&
    typeof value.credentialBindingRevision === "string" &&
    /^bind_[A-Za-z0-9_-]{32,96}$/.test(value.credentialBindingRevision);
}

async function cleanupIterator(iterator: AsyncIterator<ProviderChunk>, timeoutMs = 1_000): Promise<boolean> {
  let returnIterator: AsyncIterator<ProviderChunk>["return"];
  try {
    returnIterator = iterator.return;
  } catch {
    return false;
  }
  if (!returnIterator) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const cleanup = Promise.resolve(returnIterator.call(iterator)).then(() => true, () => false);
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([cleanup, deadline]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function nextProviderChunk(
  iterator: AsyncIterator<ProviderChunk>,
  signal: AbortSignal,
): Promise<IteratorResult<ProviderChunk>> {
  if (nativeSignalAborted(signal)) throw new ProviderTurnCancelledError();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: (value: never) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      removeNativeAbortListener(signal, onAbort);
      callback(value as never);
    };
    const onAbort = () => settle(reject, new ProviderTurnCancelledError());
    addNativeAbortListener(signal, onAbort);
    let pending: PromiseLike<IteratorResult<ProviderChunk>> | IteratorResult<ProviderChunk>;
    try {
      pending = iterator.next();
    } catch (error) {
      settle(reject, error);
      return;
    }
    void Promise.resolve(pending).then(
      (value) => settle(resolve as (value: never) => void, value),
      (error) => settle(reject, error),
    );
  });
}

function stableProviderError(error: unknown): Error {
  if (isAuthenticCredentialBrokerError(error)) return error;
  try {
    if (error instanceof ProviderPreflightError) {
      const reason = allowlistedReason(error, PREFLIGHT_REASONS);
      if (reason) return new ProviderPreflightError(reason);
    }
    if (error instanceof ProviderTransportError) {
      const reason = allowlistedReason(error, TRANSPORT_CODES);
      if (reason) return new ProviderTransportError(reason);
    }
    if (error instanceof ProviderAdapterError) {
      const reason = allowlistedReason(error, ADAPTER_ERROR_CODES);
      if (reason) return new ProviderAdapterError({ reasonCode: reason, audience: "unknown", requestId: "request-redacted" });
    }
    if (error instanceof ProviderHistoryValidationError) {
      const reason = allowlistedReason(error, HISTORY_VALIDATION_CODES);
      if (reason) return new ProviderHistoryValidationError(reason);
    }
    if (error instanceof ProviderStreamBoundaryError) {
      const reason = allowlistedReason(error, STREAM_BOUNDARY_CODES);
      if (reason) return new ProviderStreamBoundaryError(reason, "request-redacted");
    }
    if (error instanceof ReviewedToolError) {
      const reason = allowlistedReason(error, REVIEWED_TOOL_CODES);
      if (reason) return new ReviewedToolError(reason);
    }
    if (error instanceof ProviderProtocolOutputError) {
      const reason = allowlistedReason(error, PROTOCOL_OUTPUT_CODES);
      if (reason) return new ProviderProtocolOutputError(reason);
    }
    if (error instanceof ProviderRouterCleanupError) return new ProviderRouterCleanupError();
    if (error instanceof ProviderTurnCancelledError) return new ProviderTurnCancelledError();
  } catch {
    // Any hostile getter/proxy/class instance is collapsed below.
  }
  return new ProviderTransportError("outcome_unknown");
}

function retryableBeforeOutput(
  error: unknown,
  expected: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly audience: ProviderCredentialAudience;
  },
): boolean {
  if (isAuthenticCredentialBrokerError(error)) {
    const statusClass = error.reasonCode === "connect_failure_before_body"
      ? "transport_before_body"
      : "http_retryable";
    return error.retryable === true &&
      FALLBACK_BROKER_CODES.has(error.reasonCode) &&
      consumeFallbackAttestation(error, { ...expected, statusClass });
  }
  return false;
}

function validUsage(chunk: Extract<ProviderChunk, { kind: "usage" }>): boolean {
  const usage = chunk.usage;
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) && usage.totalTokens === usage.inputTokens + usage.outputTokens;
}

export class ProviderRouter {
  private readonly adapters = new Map<ProviderId, RegisteredProvider>();

  constructor(private readonly nextId: () => string = randomUUID) {}

  register(adapter: ProviderAdapter): void {
    try {
      const authority = typeof adapter?.authoritySnapshot === "function"
        ? adapter.authoritySnapshot()
        : undefined;
      if (!adapter || typeof adapter !== "object" || typeof adapter.providerId !== "string" || !adapter.providerId ||
        typeof adapter.streamTurn !== "function" || !validAuthoritySnapshot(authority) ||
        !Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
        throw new ProviderPreflightError("invalid_capability_document");
      }
      if (this.adapters.has(adapter.providerId)) throw new ProviderPreflightError("duplicate_provider");
      const capabilities = adapter.capabilities.map((item) => cloneCapability(item, adapter.providerId));
      if (new Set(capabilities.map((item) => item.modelId)).size !== capabilities.length) {
        throw new ProviderPreflightError("invalid_capability_document");
      }
      let reviewedTools: readonly ReviewedProviderTool[];
      try {
        reviewedTools = prepareReviewedTools(adapter.reviewedTools);
      } catch {
        throw new ProviderPreflightError("invalid_reviewed_tools");
      }
      this.adapters.set(adapter.providerId, Object.freeze({
        adapter,
        providerId: adapter.providerId,
        credentialAudience: authority.credentialAudience,
        capabilities: Object.freeze(capabilities),
        credentialBindingRevision: authority.credentialBindingRevision,
        reviewedTools,
      }));
    } catch (error) {
      const reason = error instanceof ProviderPreflightError
        ? allowlistedReason(error, PREFLIGHT_REASONS)
        : undefined;
      if (reason) throw new ProviderPreflightError(reason);
      throw new ProviderPreflightError("invalid_capability_document");
    }
  }

  replace(adapter: ProviderAdapter): void {
    const previous = this.adapters.get(adapter.providerId);
    if (!previous) throw new ProviderPreflightError("unknown_provider");
    this.adapters.delete(adapter.providerId);
    try {
      this.register(adapter);
    } catch (error) {
      this.adapters.set(previous.providerId, previous);
      throw error;
    }
  }

  preflight(selection: ProviderSelection): readonly EligibleProvider[] {
    if (!plainRecord(selection) || !exactKeys(selection, ["candidates", "requiredCapabilities"]) ||
      !Array.isArray(selection.candidates) || selection.candidates.length === 0 ||
      !Array.isArray(selection.requiredCapabilities)) {
      throw new ProviderPreflightError("empty_selection");
    }
    if (selection.requiredCapabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability)) ||
      new Set(selection.requiredCapabilities).size !== selection.requiredCapabilities.length) {
      throw new ProviderPreflightError("unknown_capability");
    }
    const seen = new Set<string>();
    const eligible: EligibleProvider[] = [];
    selection.candidates.forEach((candidate, fallbackIndex) => {
      if (!plainRecord(candidate) || !exactKeys(candidate, ["providerId", "modelId"]) ||
        typeof candidate.providerId !== "string" || !candidate.providerId ||
        typeof candidate.modelId !== "string" || !candidate.modelId) {
        throw new ProviderPreflightError("unknown_model");
      }
      const key = canonicalStringify([candidate.providerId, candidate.modelId]);
      if (seen.has(key)) throw new ProviderPreflightError("duplicate_candidate");
      seen.add(key);
      const candidateProviderId = asId<ProviderId>(candidate.providerId);
      const registration = this.adapters.get(candidateProviderId);
      if (!registration) throw new ProviderPreflightError("unknown_provider");
      const capability = registration.capabilities.find((item) => item.modelId === candidate.modelId);
      if (!capability) throw new ProviderPreflightError("unknown_model");
      let currentAuthority: ProviderAuthoritySnapshot | undefined;
      try {
        currentAuthority = registration.adapter.authoritySnapshot();
      } catch {
        throw new ProviderPreflightError("invalid_credential_binding");
      }
      if (!validAuthoritySnapshot(currentAuthority) ||
        currentAuthority.credentialAudience !== registration.credentialAudience ||
        currentAuthority.credentialBindingRevision !== registration.credentialBindingRevision) {
        throw new ProviderPreflightError("invalid_credential_binding");
      }
      const capable = selection.requiredCapabilities.every(
        (required) => capability[CAPABILITY_FIELDS[required]] === true,
      );
      if (!capable) {
        throw new ProviderPreflightError(fallbackIndex === 0 ? "ineligible_primary" : "ineligible_candidate");
      }
      eligible.push(Object.freeze({
        registration,
        candidate: Object.freeze({ providerId: candidateProviderId, modelId: candidate.modelId }),
        capability,
        fallbackIndex,
      }));
    });
    return Object.freeze(eligible);
  }

  signatureFor(selection: ProviderSelection): string {
    const eligible = this.preflight(selection);
    return canonicalStringify({
      signatureVersion: "provider-plan-v1",
      requiredCapabilities: [...selection.requiredCapabilities],
      candidates: eligible.map((item) => ({
        providerId: item.candidate.providerId,
        modelId: item.candidate.modelId,
        capability: item.capability,
        credentialBindingRevision: item.registration.credentialBindingRevision,
        reviewedTools: item.registration.reviewedTools.map((tool) => ({
          toolId: tool.toolId,
          wireName: tool.wireName,
          description: tool.description,
          schemaHash: tool.schemaHash,
          manifest: tool.manifest,
        })),
      })),
    });
  }

  routeTurn(
    selection: ProviderSelection,
    request: Omit<ProviderTurnRequest, "providerId" | "modelId" | "providerRequestId" | "providerAttemptId">,
    expectedSignature?: string,
  ): AsyncIterable<RoutedProviderChunk> {
    const eligible = this.preflight(selection);
    if (expectedSignature !== undefined && this.signatureFor(selection) !== expectedSignature) {
      throw new ProviderPreflightError("authority_changed");
    }
    return this.streamEligible(eligible, request);
  }

  private async *streamEligible(
    eligible: readonly EligibleProvider[],
    request: Omit<ProviderTurnRequest, "providerId" | "modelId" | "providerRequestId" | "providerAttemptId">,
  ): AsyncIterable<RoutedProviderChunk> {
    let lastError: unknown;
    for (let index = 0; index < eligible.length; index += 1) {
      if (nativeSignalAborted(request.signal)) throw new ProviderTurnCancelledError();
      const candidate = eligible[index];
      const providerId = candidate.registration.providerId;
      const modelId = candidate.candidate.modelId;
      const providerRequestId = asId<ProviderRequestId>(
        `prv_${this.nextId().replaceAll("-", "")}`,
        "provider request ID",
      );
      const providerAttemptId = asId<ProviderAttemptId>(
        `att_${this.nextId().replaceAll("-", "")}`,
        "provider attempt ID",
      );
      yield Object.freeze({
        kind: "provider_selected",
        providerId,
        modelId,
        protocolRevision: candidate.capability.protocolRevision,
        credentialBindingRevision: candidate.registration.credentialBindingRevision,
        providerRequestId,
        fallbackIndex: candidate.fallbackIndex,
      });

      let visibleOutput = false;
      let terminal = false;
      let usageSeen = false;
      let iterator: AsyncIterator<ProviderChunk> | undefined;
      try {
        const dispatchAuthority = candidate.registration.adapter.authoritySnapshot();
        if (
          this.adapters.get(providerId) !== candidate.registration ||
          !validAuthoritySnapshot(dispatchAuthority) ||
          dispatchAuthority.credentialAudience !== candidate.registration.credentialAudience ||
          dispatchAuthority.credentialBindingRevision !== candidate.registration.credentialBindingRevision
        ) {
          throw new ProviderPreflightError("authority_changed");
        }
        iterator = candidate.registration.adapter.streamTurn({
          ...request,
          providerId,
          modelId,
          providerRequestId,
          providerAttemptId,
        })[Symbol.asyncIterator]();
        for (;;) {
          if (nativeSignalAborted(request.signal)) throw new ProviderTurnCancelledError();
          const next = await nextProviderChunk(iterator, request.signal);
          if (next.done) break;
          if (nativeSignalAborted(request.signal)) throw new ProviderTurnCancelledError();
          const chunk = next.value;
          if (terminal) throw new ProviderProtocolOutputError("chunk_after_terminal");
          if (chunk.kind === "usage") {
            if (usageSeen || !validUsage(chunk)) throw new ProviderProtocolOutputError("invalid_usage");
            usageSeen = true;
          } else if (usageSeen && chunk.kind === "delta") {
            throw new ProviderProtocolOutputError("invalid_usage");
          }
          if (chunk.kind === "delta" && chunk.text.length > 0) visibleOutput = true;
          if (chunk.kind === "tool_proposal") {
            visibleOutput = true;
            terminal = true;
          }
          if (chunk.kind === "finish") terminal = true;
          if (chunk.kind === "tool_proposal") {
            const reviewedTool = candidate.registration.reviewedTools.find((tool) => tool.toolId === chunk.toolId);
            if (!reviewedTool) throw new ReviewedToolError("unadvertised_tool");
            yield Object.freeze({
              kind: "provider_chunk",
              providerId,
              modelId,
              chunk,
              reviewedToolAuthority: Object.freeze({
                toolId: reviewedTool.toolId,
                schemaHash: reviewedTool.schemaHash,
                manifestHash: canonicalHash(reviewedTool.manifest),
              }),
            });
          } else {
            yield Object.freeze({ kind: "provider_chunk", providerId, modelId, chunk });
          }
        }
        const cleaned = await cleanupIterator(iterator);
        iterator = undefined;
        if (!cleaned) throw new ProviderRouterCleanupError();
        if (!terminal) throw new ProviderProtocolOutputError("missing_terminal");
        return;
      } catch (error) {
        if (iterator) {
          const cleaned = await cleanupIterator(iterator);
          iterator = undefined;
          if (!cleaned) throw new ProviderRouterCleanupError();
        }
        if (nativeSignalAborted(request.signal) || error instanceof ProviderTurnCancelledError) {
          throw new ProviderTurnCancelledError();
        }
        if (visibleOutput) throw new ProviderFailureAfterOutputError(providerId);
        const stableError = stableProviderError(error);
        lastError = stableError;
        if (!retryableBeforeOutput(stableError, {
          requestId: providerRequestId,
          attemptId: providerAttemptId,
          providerId,
          modelId,
          audience: candidate.registration.credentialAudience,
        }) || index === eligible.length - 1) throw stableError;
      } finally {
        if (iterator) {
          const cleaned = await cleanupIterator(iterator);
          iterator = undefined;
          if (!cleaned) throw new ProviderRouterCleanupError();
        }
      }
    }
    throw lastError ?? new ProviderPreflightError("empty_selection");
  }
}
