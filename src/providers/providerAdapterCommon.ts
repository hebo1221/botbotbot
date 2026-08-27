import { canonicalStringify } from "../domain/canonical";
import {
  asId,
  type CredentialBindingRevision,
  type ProviderAttemptId,
  type ProviderHistoryRecord,
  type ProviderId,
  type ProviderModelCapabilitySnapshot,
  type ProviderRequestId,
  type ProviderTurnRequest,
  type ReviewedProviderTool,
} from "../domain/contracts";
import {
  CREDENTIAL_AUDIENCES,
  bindingLeaseIsCurrentForBroker,
  credentialBrokerErrorMatchesInvocation,
  isNativeAbortSignal,
  normalizeProviderRequestId,
  validateCredentialBindingLease,
  type CredentialAudience,
  type CredentialBroker,
  type CredentialBindingLease,
  type CredentialBrokerInvocationIdentity,
  type BrokerStreamResponse,
} from "./credentialBroker";
import {
  DEFAULT_PROVIDER_STREAM_LIMITS,
  normalizeProviderStreamBoundaryCode,
  ProviderStreamBoundaryError,
  validateProviderStreamLimits,
  type ProviderStreamLimits,
} from "./providerStream";
import {
  normalizeReviewedToolErrorCode,
  prepareReviewedTools,
  ReviewedToolError,
} from "./reviewedTools";

export type ProviderAdapterErrorCode =
  | "invalid_adapter_configuration"
  | "invalid_turn_request"
  | "unsupported_model"
  | "protocol_violation"
  | "malformed_order"
  | "duplicate_identity"
  | "unknown_authority_event"
  | "provider_error"
  | "incomplete_response"
  | "refusal"
  | "multiple_tool_calls"
  | "reasoning_round_trip_unavailable"
  | "secret_reflection_blocked";

const ADAPTER_CODES = new Set<ProviderAdapterErrorCode>([
  "invalid_adapter_configuration",
  "invalid_turn_request",
  "unsupported_model",
  "protocol_violation",
  "malformed_order",
  "duplicate_identity",
  "unknown_authority_event",
  "provider_error",
  "incomplete_response",
  "refusal",
  "multiple_tool_calls",
  "reasoning_round_trip_unavailable",
  "secret_reflection_blocked",
]);

export function normalizeProviderAdapterErrorCode(value: unknown): ProviderAdapterErrorCode | undefined {
  return typeof value === "string" && ADAPTER_CODES.has(value as ProviderAdapterErrorCode)
    ? value as ProviderAdapterErrorCode
    : undefined;
}

export class ProviderAdapterError extends Error {
  readonly reasonCode: ProviderAdapterErrorCode;
  readonly retryable = false;
  readonly audience: CredentialAudience | "unknown";
  readonly requestId: string;

  constructor(input: {
    readonly reasonCode: ProviderAdapterErrorCode;
    readonly audience: CredentialAudience | "unknown";
    readonly requestId: string;
  }) {
    const reasonCode = normalizeProviderAdapterErrorCode(input.reasonCode) ?? "protocol_violation";
    const audience = input.audience === "unknown" || CREDENTIAL_AUDIENCES.includes(input.audience)
      ? input.audience
      : "unknown";
    const requestId = normalizeProviderRequestId(input.requestId);
    super(`Provider adapter ${requestId} stopped (${reasonCode}).`);
    this.name = "ProviderAdapterError";
    this.reasonCode = reasonCode;
    this.audience = audience;
    this.requestId = requestId;
    Object.freeze(this);
  }

  toJSON(): Readonly<Record<string, string | boolean>> {
    return Object.freeze({
      name: this.name,
      reasonCode: this.reasonCode,
      retryable: false,
      audience: this.audience,
      requestId: this.requestId,
    });
  }
}

export interface ProviderAdapterOptions {
  readonly broker: CredentialBroker;
  readonly binding: CredentialBindingLease;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly reviewedTools?: readonly ReviewedProviderTool[];
  readonly limits?: ProviderStreamLimits;
}

export interface PreparedAdapterConfiguration {
  readonly providerId: ProviderId;
  readonly audience: CredentialAudience;
  readonly broker: CredentialBroker;
  readonly binding: CredentialBindingLease;
  readonly credentialBindingRevision: CredentialBindingRevision;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly reviewedTools: readonly ReviewedProviderTool[];
  readonly limits: ProviderStreamLimits;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function brokerStreamResponseMatchesInvocation(
  value: unknown,
  expected: CredentialBrokerInvocationIdentity,
): value is BrokerStreamResponse {
  try {
    if (!plainRecord(value) || !exactKeys(value, [
      "requestId",
      "attemptId",
      "providerId",
      "modelId",
      "audience",
      "body",
      "assertCredentialAbsent",
      "quarantineDecoded",
    ])) return false;
    const body = ownDataValue(value, "body");
    return ownDataValue(value, "requestId") === expected.requestId &&
      ownDataValue(value, "attemptId") === expected.attemptId &&
      ownDataValue(value, "providerId") === expected.providerId &&
      ownDataValue(value, "modelId") === expected.modelId &&
      ownDataValue(value, "audience") === expected.audience &&
      typeof ownDataValue(value, "assertCredentialAbsent") === "function" &&
      typeof ownDataValue(value, "quarantineDecoded") === "function" &&
      body !== null && (typeof body === "object" || typeof body === "function") &&
      typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
  } catch {
    return false;
  }
}

function ownErrorReason(error: unknown): unknown {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  return ownDataValue(error, "reasonCode");
}

export function sanitizeProviderAdapterBoundaryError(
  error: unknown,
  config: PreparedAdapterConfiguration,
  requestId: string,
  invocation: CredentialBrokerInvocationIdentity,
): Error {
  try {
    if (credentialBrokerErrorMatchesInvocation(error, invocation) && Object.isFrozen(error)) {
      return error;
    }
    const reason = ownErrorReason(error);
    if (error instanceof ProviderAdapterError) {
      return new ProviderAdapterError({
        reasonCode: normalizeProviderAdapterErrorCode(reason) ?? "protocol_violation",
        audience: config.audience,
        requestId,
      });
    }
    if (error instanceof ProviderStreamBoundaryError) {
      return Object.freeze(new ProviderStreamBoundaryError(
        normalizeProviderStreamBoundaryCode(reason) ?? "upstream_stream_failure",
        requestId,
        config.audience,
      ));
    }
    if (error instanceof ReviewedToolError) {
      const reviewedReason = normalizeReviewedToolErrorCode(reason);
      return new ProviderAdapterError({
        reasonCode: reviewedReason === "unadvertised_tool"
          ? "unknown_authority_event"
          : "protocol_violation",
        audience: config.audience,
        requestId,
      });
    }
  } catch {
    // Hostile prototypes, getters, and proxies collapse to the stable default.
  }
  return new ProviderAdapterError({
    reasonCode: "protocol_violation",
    audience: config.audience,
    requestId,
  });
}

function snapshot(
  value: unknown,
  providerId: ProviderId,
  protocolRevision: string,
): ProviderModelCapabilitySnapshot {
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
    value.protocolRevision !== protocolRevision ||
    !["streaming", "toolProposals", "imageInput", "usage", "cancellation", "opaqueReasoningRoundTrip"]
      .every((key) => typeof value[key] === "boolean") ||
    value.streaming !== true || value.usage !== true || value.cancellation !== true ||
    value.imageInput !== false || value.opaqueReasoningRoundTrip !== false) {
    throw new Error("invalid snapshot");
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

export function prepareAdapterConfiguration(
  providerIdValue: string,
  audience: CredentialAudience,
  optionsValue: ProviderAdapterOptions,
  protocolRevision: string,
): PreparedAdapterConfiguration {
  try {
    const providerId = asId<ProviderId>(providerIdValue, "provider ID");
    if (!plainRecord(optionsValue) || !exactKeys(optionsValue, [
      "broker",
      "binding",
      "capabilities",
    ], ["reviewedTools", "limits"]) ||
      !optionsValue.broker || typeof optionsValue.broker.exchange !== "function" ||
      typeof optionsValue.broker.bindingIsCurrent !== "function" ||
      !Array.isArray(optionsValue.capabilities) || optionsValue.capabilities.length === 0) {
      throw new Error("invalid options");
    }
    const binding = validateCredentialBindingLease(optionsValue.binding);
    if (binding.audience !== audience || !bindingLeaseIsCurrentForBroker(optionsValue.broker, binding)) {
      throw new Error("audience mismatch");
    }
    const capabilities = optionsValue.capabilities.map((item) => snapshot(item, providerId, protocolRevision));
    if (new Set(capabilities.map((item) => item.modelId)).size !== capabilities.length) {
      throw new Error("duplicate model");
    }
    const reviewedTools = prepareReviewedTools(optionsValue.reviewedTools ?? []);
    const limits = validateProviderStreamLimits(optionsValue.limits ?? DEFAULT_PROVIDER_STREAM_LIMITS);
    return Object.freeze({
      providerId,
      audience,
      broker: optionsValue.broker,
      binding,
      credentialBindingRevision: binding.revision as CredentialBindingRevision,
      capabilities: Object.freeze(capabilities),
      reviewedTools,
      limits,
    });
  } catch {
    throw new ProviderAdapterError({
      reasonCode: "invalid_adapter_configuration",
      audience,
      requestId: "request-preflight",
    });
  }
}

function validInternalId(value: unknown, prefix: "prv_" | "att_"): value is string {
  return typeof value === "string" && value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]+$/.test(value) && value.length >= 20 && value.length <= 128;
}

export function validateProviderTurnRequest(
  requestValue: ProviderTurnRequest,
  config: PreparedAdapterConfiguration,
): {
  readonly requestId: ProviderRequestId;
  readonly attemptId: ProviderAttemptId;
  readonly model: ProviderModelCapabilitySnapshot;
  readonly history: readonly ProviderHistoryRecord[];
  readonly signal: AbortSignal;
} {
  let requestId = "request-invalid";
  let locallyIssued: ProviderAdapterError | undefined;
  try {
    if (!plainRecord(requestValue) || !exactKeys(requestValue, [
      "workspaceId",
      "conversationId",
      "turnId",
      "providerRequestId",
      "providerAttemptId",
      "providerId",
      "modelId",
      "history",
      "signal",
    ], ["directionEpoch"])) throw new Error("shape");
    if (!validInternalId(requestValue.providerRequestId, "prv_") ||
      !validInternalId(requestValue.providerAttemptId, "att_")) throw new Error("IDs");
    requestId = requestValue.providerRequestId;
    if (!isNativeAbortSignal(requestValue.signal) || !Array.isArray(requestValue.history) ||
      typeof requestValue.workspaceId !== "string" || !requestValue.workspaceId ||
      typeof requestValue.conversationId !== "string" || !requestValue.conversationId ||
      typeof requestValue.turnId !== "string" || !requestValue.turnId ||
      requestValue.providerId !== config.providerId ||
      typeof requestValue.modelId !== "string" || !requestValue.modelId ||
      (requestValue.directionEpoch !== undefined &&
        (!Number.isSafeInteger(requestValue.directionEpoch) || requestValue.directionEpoch < 1))) {
      throw new Error("values");
    }
    const model = config.capabilities.find((item) => item.modelId === requestValue.modelId);
    if (!model) {
      locallyIssued = new ProviderAdapterError({
        reasonCode: "unsupported_model",
        audience: config.audience,
        requestId,
      });
      throw locallyIssued;
    }
    return Object.freeze({
      requestId: requestValue.providerRequestId,
      attemptId: requestValue.providerAttemptId,
      model,
      history: requestValue.history,
      signal: requestValue.signal,
    });
  } catch (error) {
    if (error === locallyIssued) throw locallyIssued;
    throw new ProviderAdapterError({
      reasonCode: "invalid_turn_request",
      audience: config.audience,
      requestId,
    });
  }
}

export function capabilitySignatureMaterial(config: PreparedAdapterConfiguration): string {
  return canonicalStringify({
    providerId: config.providerId,
    credentialBindingRevision: config.credentialBindingRevision,
    capabilities: config.capabilities,
    reviewedTools: config.reviewedTools.map((tool) => ({
      toolId: tool.toolId,
      wireName: tool.wireName,
      schemaHash: tool.schemaHash,
      manifest: tool.manifest,
    })),
  });
}

export function adapterFailure(
  reasonCode: ProviderAdapterErrorCode,
  config: PreparedAdapterConfiguration,
  requestId: string,
): ProviderAdapterError {
  return new ProviderAdapterError({ reasonCode, audience: config.audience, requestId });
}
