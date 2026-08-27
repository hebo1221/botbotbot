import { randomUUID } from "node:crypto";
import type { JsonValue } from "../domain/canonical";
import { validateCanonicalJsonBytes } from "./strictJson";

export const CREDENTIAL_AUDIENCES = ["openai", "anthropic", "openrouter"] as const;
export type CredentialAudience = (typeof CREDENTIAL_AUDIENCES)[number];

export const PROVIDER_ROUTES = [
  "openai_responses",
  "anthropic_messages",
  "openrouter_responses",
] as const;
export type ProviderRoute = (typeof PROVIDER_ROUTES)[number];

export interface CredentialBindingLease {
  readonly bindingId: string;
  readonly audience: CredentialAudience;
  readonly revision: string;
}

export interface AuthorizedProviderRequest {
  readonly binding: CredentialBindingLease;
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly route: ProviderRoute;
  readonly canonicalBody: Uint8Array;
  readonly signal: AbortSignal;
}

export interface CredentialBrokerInvocationIdentity {
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly audience: CredentialAudience;
}

export interface BrokerStreamResponse extends CredentialBrokerInvocationIdentity {
  readonly body: AsyncIterable<Uint8Array>;
  assertCredentialAbsent(value: unknown): void;
  quarantineDecoded(channel: string, value: string, final?: boolean): string;
}

export interface CredentialBroker {
  exchange(request: AuthorizedProviderRequest): Promise<BrokerStreamResponse>;
  bindingIsCurrent(binding: CredentialBindingLease): boolean;
}

export interface BrokerAttemptMonitor {
  recordRequestBodyBytes(byteCount: number): void;
  requestBodyBytesWritten(): number;
  assertBindingCurrent(): void;
  failure(
    reasonCode: Exclude<CredentialBrokerErrorCode, "connect_failure_before_body" | "http_retryable_before_stream">,
    statusClass: BrokerStatusClass,
  ): CredentialBrokerError;
  readonly signal: AbortSignal;
  readonly dispatchStartedAt: number;
  readonly totalDeadline: number;
  readonly initialIdleDeadline: number;
}

export type PrivilegedBrokerExchangeResult =
  | { readonly kind: "response"; readonly response: BrokerStreamResponse }
  | { readonly kind: "connect_failure_before_body" }
  | { readonly kind: "http_status_before_stream"; readonly status: number };

export interface BrokerDestinationPolicy {
  readonly audience: CredentialAudience;
  readonly route: ProviderRoute;
  readonly origin: `https://${string}`;
  readonly path: string;
  readonly method: "POST";
  readonly credentialHeader: "authorization" | "x-api-key";
  readonly generatedPublicHeaders: Readonly<Record<string, string>>;
}

export const BROKER_DESTINATIONS: Readonly<Record<ProviderRoute, BrokerDestinationPolicy>> =
  Object.freeze({
    openai_responses: Object.freeze({
      audience: "openai",
      route: "openai_responses",
      origin: "https://api.openai.com",
      path: "/v1/responses",
      method: "POST",
      credentialHeader: "authorization",
      generatedPublicHeaders: Object.freeze({
        accept: "text/event-stream",
        "content-type": "application/json",
      }),
    }),
    anthropic_messages: Object.freeze({
      audience: "anthropic",
      route: "anthropic_messages",
      origin: "https://api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      credentialHeader: "x-api-key",
      generatedPublicHeaders: Object.freeze({
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      }),
    }),
    openrouter_responses: Object.freeze({
      audience: "openrouter",
      route: "openrouter_responses",
      origin: "https://openrouter.ai",
      path: "/api/v1/responses",
      method: "POST",
      credentialHeader: "authorization",
      generatedPublicHeaders: Object.freeze({
        accept: "text/event-stream",
        "content-type": "application/json",
      }),
    }),
  });

export const BROKER_LIMITS = Object.freeze({
  maxRequestBodyBytes: 16 * 1024 * 1024,
  maxRequestHeaderBytes: 16 * 1024,
  maxResponseHeaderBytes: 32 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxProviderIdBytes: 512,
  maxStreamDurationMs: 600_000,
  maxIdleMs: 30_000,
});

export const RETRYABLE_HTTP_STATUSES = Object.freeze([408, 429, 500, 502, 503, 504, 524, 529] as const);

export type CredentialBrokerErrorCode =
  | "invalid_descriptor"
  | "credential_unavailable"
  | "request_replayed"
  | "request_too_large"
  | "request_headers_too_large"
  | "secret_reflection_blocked"
  | "redirect_blocked"
  | "http_retryable_before_stream"
  | "http_non_retryable"
  | "connect_failure_before_body"
  | "outcome_unknown"
  | "invalid_response_headers"
  | "invalid_response"
  | "response_too_large"
  | "idle_timeout"
  | "duration_exceeded"
  | "request_cancelled"
  | "cleanup_failed";

export type BrokerStatusClass =
  | "request_rejected"
  | "credential"
  | "redirect"
  | "http_retryable"
  | "http_non_retryable"
  | "transport_before_body"
  | "outcome_unknown"
  | "response_invalid"
  | "bounds"
  | "cancelled"
  | "cleanup";

const ERROR_CODES = new Set<CredentialBrokerErrorCode>([
  "invalid_descriptor",
  "credential_unavailable",
  "request_replayed",
  "request_too_large",
  "request_headers_too_large",
  "secret_reflection_blocked",
  "redirect_blocked",
  "http_retryable_before_stream",
  "http_non_retryable",
  "connect_failure_before_body",
  "outcome_unknown",
  "invalid_response_headers",
  "invalid_response",
  "response_too_large",
  "idle_timeout",
  "duration_exceeded",
  "request_cancelled",
  "cleanup_failed",
]);
const STATUS_CLASSES = new Set<BrokerStatusClass>([
  "request_rejected",
  "credential",
  "redirect",
  "http_retryable",
  "http_non_retryable",
  "transport_before_body",
  "outcome_unknown",
  "response_invalid",
  "bounds",
  "cancelled",
  "cleanup",
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{11,127}$/;
const AUTHENTIC_BROKER_ERRORS = new WeakSet<CredentialBrokerError>();
interface BrokerErrorIdentity {
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly audience: CredentialAudience | "unknown";
}
const BROKER_ERROR_IDENTITIES = new WeakMap<CredentialBrokerError, BrokerErrorIdentity>();
interface FallbackAttestationState {
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly audience: CredentialAudience;
  readonly statusClass: "transport_before_body" | "http_retryable";
  consumed: boolean;
}
const FALLBACK_ATTESTATIONS = new WeakMap<CredentialBrokerError, FallbackAttestationState>();

export function normalizeProviderRequestId(value: unknown): string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) &&
      new TextEncoder().encode(value).byteLength <= BROKER_LIMITS.maxProviderIdBytes
    ? value
    : "request-invalid";
}

export class CredentialBrokerError extends Error {
  readonly reasonCode: CredentialBrokerErrorCode;
  readonly retryable: boolean;
  readonly audience: CredentialAudience | "unknown";
  readonly requestId: string;
  readonly statusClass: BrokerStatusClass;

  constructor(input: {
    readonly reasonCode: CredentialBrokerErrorCode;
    readonly retryable: boolean;
    readonly audience: CredentialAudience | "unknown";
    readonly requestId: string;
    readonly statusClass: BrokerStatusClass;
  }) {
    const reasonCode = ERROR_CODES.has(input.reasonCode) ? input.reasonCode : "invalid_descriptor";
    const statusClass = STATUS_CLASSES.has(input.statusClass) ? input.statusClass : "request_rejected";
    const audience = input.audience === "unknown" ||
      CREDENTIAL_AUDIENCES.includes(input.audience as CredentialAudience)
      ? input.audience
      : "unknown";
    const requestId = normalizeProviderRequestId(input.requestId);
    super(`Credential broker request ${requestId} stopped (${reasonCode}).`);
    this.name = "CredentialBrokerError";
    this.reasonCode = reasonCode;
    this.retryable = reasonCode === "connect_failure_before_body" ||
      reasonCode === "http_retryable_before_stream"
      ? input.retryable === true
      : false;
    this.audience = audience;
    this.requestId = requestId;
    this.statusClass = statusClass;
  }

  toJSON(): Readonly<Record<string, string | boolean>> {
    return Object.freeze({
      name: this.name,
      reasonCode: this.reasonCode,
      retryable: this.retryable,
      audience: this.audience,
      requestId: this.requestId,
      statusClass: this.statusClass,
    });
  }
}

type BrokerErrorCreationInput = ConstructorParameters<typeof CredentialBrokerError>[0] & {
  readonly attemptId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
};

function createCredentialBrokerError(input: BrokerErrorCreationInput): CredentialBrokerError {
  const error = new CredentialBrokerError(input);
  const identity = Object.freeze({
    requestId: error.requestId,
    attemptId: typeof input.attemptId === "string" && /^att_[A-Za-z0-9_-]{16,124}$/.test(input.attemptId)
      ? input.attemptId
      : "attempt-invalid",
    providerId: typeof input.providerId === "string" && input.providerId ? input.providerId : "provider-unknown",
    modelId: typeof input.modelId === "string" && input.modelId ? input.modelId : "model-unknown",
    audience: error.audience,
  });
  AUTHENTIC_BROKER_ERRORS.add(error);
  BROKER_ERROR_IDENTITIES.set(error, identity);
  const fallbackStatus = error.reasonCode === "connect_failure_before_body"
    ? "transport_before_body"
    : "http_retryable";
  if (error.retryable && error.audience !== "unknown" && identity.attemptId !== "attempt-invalid" &&
    error.statusClass === fallbackStatus) {
    FALLBACK_ATTESTATIONS.set(error, {
      requestId: error.requestId,
      attemptId: identity.attemptId,
      providerId: identity.providerId,
      modelId: identity.modelId,
      audience: error.audience,
      statusClass: fallbackStatus,
      consumed: false,
    });
  }
  return Object.freeze(error);
}

export function isAuthenticCredentialBrokerError(value: unknown): value is CredentialBrokerError {
  try {
    if (!(value instanceof CredentialBrokerError) || !AUTHENTIC_BROKER_ERRORS.has(value)) return false;
    const identity = BROKER_ERROR_IDENTITIES.get(value);
    if (!identity) return false;
    return (
      ERROR_CODES.has(value.reasonCode) &&
      STATUS_CLASSES.has(value.statusClass) &&
      (value.audience === "unknown" || CREDENTIAL_AUDIENCES.includes(value.audience)) &&
      normalizeProviderRequestId(value.requestId) === value.requestId &&
      identity.requestId === value.requestId &&
      identity.audience === value.audience &&
      (/^att_[A-Za-z0-9_-]{16,124}$/.test(identity.attemptId) || identity.attemptId === "attempt-invalid") &&
      Boolean(identity.providerId) &&
      Boolean(identity.modelId) &&
      value.message === `Credential broker request ${value.requestId} stopped (${value.reasonCode}).` &&
      value.retryable === (
        value.reasonCode === "connect_failure_before_body" ||
        value.reasonCode === "http_retryable_before_stream"
      )
    );
  } catch {
    return false;
  }
}

export function credentialBrokerErrorMatchesInvocation(
  value: unknown,
  expected: CredentialBrokerInvocationIdentity,
): value is CredentialBrokerError {
  try {
    if (!isAuthenticCredentialBrokerError(value)) return false;
    const identity = BROKER_ERROR_IDENTITIES.get(value);
    return Boolean(identity &&
      identity.requestId === expected.requestId &&
      identity.attemptId === expected.attemptId &&
      identity.providerId === expected.providerId &&
      identity.modelId === expected.modelId &&
      identity.audience === expected.audience);
  } catch {
    return false;
  }
}

export function consumeFallbackAttestation(
  error: CredentialBrokerError,
  expected: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly audience: CredentialAudience;
    readonly statusClass: "transport_before_body" | "http_retryable";
  },
): boolean {
  const state = FALLBACK_ATTESTATIONS.get(error);
  if (!state || state.consumed ||
    state.requestId !== expected.requestId ||
    state.attemptId !== expected.attemptId ||
    state.providerId !== expected.providerId ||
    state.modelId !== expected.modelId ||
    state.audience !== expected.audience ||
    state.statusClass !== expected.statusClass ||
    error.statusClass !== expected.statusClass) {
    return false;
  }
  state.consumed = true;
  return true;
}

export interface AuthorizedBrokerDestination {
  readonly binding: CredentialBindingLease;
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly audience: CredentialAudience;
  readonly route: ProviderRoute;
  readonly origin: `https://${string}`;
  readonly path: string;
  readonly method: "POST";
  readonly credentialHeader: "authorization" | "x-api-key";
  readonly generatedPublicHeaders: Readonly<Record<string, string>>;
  readonly canonicalBody: Uint8Array;
  readonly parsedBody: JsonValue;
  readonly signal: AbortSignal;
  readonly redirect: "error";
  readonly automaticRetries: 0;
  readonly ambientProxy: "disabled";
}

export interface BrokerTransportAttempt {
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly audience: CredentialAudience;
}

interface BrokerTransportAttemptState {
  bodyBytesWritten: number;
  terminal: boolean;
}

const AUTHORIZED_DESTINATIONS = new WeakSet<object>();
const BROKER_TRANSPORT_ATTEMPTS = new WeakMap<object, BrokerTransportAttemptState>();
interface BindingLeaseState {
  readonly owner: PrivilegedCredentialBroker;
  readonly audience: CredentialAudience;
  readonly revision: string;
  current: boolean;
}
const BINDING_LEASES = new WeakMap<object, BindingLeaseState>();

export function bindingLeaseIsCurrentForBroker(
  broker: CredentialBroker,
  lease: CredentialBindingLease,
): boolean {
  try {
    const state = BINDING_LEASES.get(lease as object);
    return Boolean(
      state?.owner === broker &&
      state.current &&
      state.audience === lease.audience &&
      state.revision === lease.revision,
    );
  } catch {
    return false;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isNativeAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object") return false;
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (!getter) return false;
  try {
    return typeof getter.call(value) === "boolean";
  } catch {
    return false;
  }
}

export function nativeSignalAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (!getter) return true;
  try {
    return getter.call(signal) as boolean;
  } catch {
    return true;
  }
}

export function addNativeAbortListener(signal: AbortSignal, listener: () => void): void {
  EventTarget.prototype.addEventListener.call(signal, "abort", listener, { once: true });
}

export function removeNativeAbortListener(signal: AbortSignal, listener: () => void): void {
  EventTarget.prototype.removeEventListener.call(signal, "abort", listener);
}

function safeField(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("invalid field");
  return descriptor.value;
}

function reject(
  reasonCode: CredentialBrokerErrorCode,
  audience: CredentialAudience | "unknown",
  requestId: string,
  statusClass: BrokerStatusClass = "request_rejected",
): never {
  throw createCredentialBrokerError({
    reasonCode,
    retryable: false,
    audience,
    requestId,
    statusClass,
  });
}

export function validateCredentialBindingLease(
  value: unknown,
  requestId = "request-invalid",
): CredentialBindingLease {
  const safeRequestId = normalizeProviderRequestId(requestId);
  const locallyIssued = new WeakSet<CredentialBrokerError>();
  const localReject = (): never => {
    const error = createCredentialBrokerError({
      reasonCode: "invalid_descriptor",
      retryable: false,
      audience: "unknown",
      requestId: safeRequestId,
      statusClass: "request_rejected",
    });
    locallyIssued.add(error);
    throw error;
  };
  try {
    if (!plainRecord(value) || !exactKeys(value, ["bindingId", "audience", "revision"])) {
      localReject();
    }
    const record = value as Record<string, unknown>;
    const bindingId = safeField(record, "bindingId");
    const audience = safeField(record, "audience");
    const revision = safeField(record, "revision");
    if (
      typeof bindingId !== "string" ||
      !/^binding_[A-Za-z0-9_-]{32,96}$/.test(bindingId) ||
      typeof audience !== "string" ||
      !CREDENTIAL_AUDIENCES.includes(audience as CredentialAudience) ||
      typeof revision !== "string" ||
      !/^bind_[A-Za-z0-9_-]{32,96}$/.test(revision) ||
      !BINDING_LEASES.has(value as object)
    ) {
      localReject();
    }
    return value as CredentialBindingLease;
  } catch (error) {
    if (error instanceof CredentialBrokerError && locallyIssued.has(error)) throw error;
    return localReject();
  }
}

export function authorizeProviderRequest(value: unknown): AuthorizedBrokerDestination {
  let requestId = "request-invalid";
  let audience: CredentialAudience | "unknown" = "unknown";
  const locallyIssued = new WeakSet<CredentialBrokerError>();
  const localReject = (
    reasonCode: CredentialBrokerErrorCode,
    statusClass: BrokerStatusClass = "request_rejected",
  ): never => {
    const error = createCredentialBrokerError({
      reasonCode,
      retryable: false,
      audience,
      requestId,
      statusClass,
    });
    locallyIssued.add(error);
    throw error;
  };
  try {
    if (!plainRecord(value) || !exactKeys(value, [
      "binding",
      "requestId",
      "attemptId",
      "providerId",
      "modelId",
      "route",
      "canonicalBody",
      "signal",
    ])) {
      localReject("invalid_descriptor");
    }
    const record = value as Record<string, unknown>;
    requestId = normalizeProviderRequestId(safeField(record, "requestId"));
    if (requestId === "request-invalid") localReject("invalid_descriptor");
    const attemptId = safeField(record, "attemptId");
    const providerId = safeField(record, "providerId");
    const modelId = safeField(record, "modelId");
    if (typeof attemptId !== "string" || !/^att_[A-Za-z0-9_-]{16,124}$/.test(attemptId) ||
      typeof providerId !== "string" || !providerId ||
      typeof modelId !== "string" || !modelId ||
      new TextEncoder().encode(providerId).byteLength > BROKER_LIMITS.maxProviderIdBytes ||
      new TextEncoder().encode(modelId).byteLength > BROKER_LIMITS.maxProviderIdBytes) {
      localReject("invalid_descriptor");
    }
    const binding = validateCredentialBindingLease(safeField(record, "binding"), requestId);
    audience = binding.audience;
    const route = safeField(record, "route");
    if (typeof route !== "string" || !PROVIDER_ROUTES.includes(route as ProviderRoute)) {
      localReject("invalid_descriptor");
    }
    const policy = BROKER_DESTINATIONS[route as ProviderRoute];
    if (policy.audience !== audience) {
      localReject("invalid_descriptor");
    }
    const signal = safeField(record, "signal");
    if (!isNativeAbortSignal(signal)) localReject("invalid_descriptor");
    const canonicalBody = safeField(record, "canonicalBody");
    let parsedBody!: JsonValue;
    try {
      parsedBody = validateCanonicalJsonBytes(canonicalBody, BROKER_LIMITS.maxRequestBodyBytes);
    } catch {
      localReject(
        canonicalBody instanceof Uint8Array &&
          canonicalBody.byteLength > BROKER_LIMITS.maxRequestBodyBytes
          ? "request_too_large"
          : "invalid_descriptor",
      );
    }
    const destination = Object.freeze({
      binding,
      requestId,
      attemptId: attemptId as string,
      providerId: providerId as string,
      modelId: modelId as string,
      audience,
      route: route as ProviderRoute,
      origin: policy.origin,
      path: policy.path,
      method: policy.method,
      credentialHeader: policy.credentialHeader,
      generatedPublicHeaders: policy.generatedPublicHeaders,
      canonicalBody: new Uint8Array(canonicalBody as Uint8Array),
      parsedBody,
      signal: signal as AbortSignal,
      redirect: "error",
      automaticRetries: 0,
      ambientProxy: "disabled",
    });
    AUTHORIZED_DESTINATIONS.add(destination);
    return destination;
  } catch (error) {
    if (error instanceof CredentialBrokerError && locallyIssued.has(error)) throw error;
    return localReject("invalid_descriptor");
  }
}

function beginBrokerTransportAttempt(
  destination: AuthorizedBrokerDestination,
): BrokerTransportAttempt {
  if (!AUTHORIZED_DESTINATIONS.has(destination)) {
    throw createCredentialBrokerError({
      reasonCode: "invalid_descriptor",
      retryable: false,
      audience: "unknown",
      requestId: "request-invalid",
      statusClass: "request_rejected",
    });
  }
  const attempt = Object.freeze({
    requestId: destination.requestId,
    attemptId: destination.attemptId,
    providerId: destination.providerId,
    modelId: destination.modelId,
    audience: destination.audience,
  });
  BROKER_TRANSPORT_ATTEMPTS.set(attempt, { bodyBytesWritten: 0, terminal: false });
  return attempt;
}

function recordBrokerRequestBodyBytes(
  attempt: BrokerTransportAttempt,
  byteCount: number,
): void {
  const state = BROKER_TRANSPORT_ATTEMPTS.get(attempt);
  if (!state || state.terminal || !Number.isSafeInteger(byteCount) || byteCount < 0) {
    throw createCredentialBrokerError({
      reasonCode: "invalid_descriptor",
      retryable: false,
      audience: "unknown",
      requestId: "request-invalid",
      statusClass: "request_rejected",
    });
  }
  state.bodyBytesWritten += byteCount;
}

function brokerRequestBodyBytesWritten(attempt: BrokerTransportAttempt): number {
  const state = BROKER_TRANSPORT_ATTEMPTS.get(attempt);
  if (!state) return -1;
  return state.bodyBytesWritten;
}

function classifyConnectFailureBeforeBody(
  attempt: BrokerTransportAttempt,
): CredentialBrokerError {
  const state = BROKER_TRANSPORT_ATTEMPTS.get(attempt);
  if (!state || state.terminal || state.bodyBytesWritten !== 0) {
    return createCredentialBrokerError({
      reasonCode: "outcome_unknown",
      retryable: false,
      audience: state ? attempt.audience : "unknown",
      requestId: state ? attempt.requestId : "request-invalid",
      statusClass: "outcome_unknown",
    });
  }
  state.terminal = true;
  return createCredentialBrokerError({
    reasonCode: "connect_failure_before_body",
    retryable: true,
    audience: attempt.audience,
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    statusClass: "transport_before_body",
  });
}

export abstract class PrivilegedCredentialBroker implements CredentialBroker {
  protected issueBindingLease(audience: CredentialAudience): CredentialBindingLease {
    if (!CREDENTIAL_AUDIENCES.includes(audience)) {
      throw createCredentialBrokerError({
        reasonCode: "invalid_descriptor",
        retryable: false,
        audience: "unknown",
        requestId: "request-invalid",
        statusClass: "request_rejected",
      });
    }
    const lease = Object.freeze({
      bindingId: `binding_${randomUUID().replaceAll("-", "")}`,
      audience,
      revision: `bind_${randomUUID().replaceAll("-", "")}`,
    });
    BINDING_LEASES.set(lease, {
      owner: this,
      audience,
      revision: lease.revision,
      current: true,
    });
    return lease;
  }

  protected invalidateBindingLease(lease: CredentialBindingLease): void {
    const state = BINDING_LEASES.get(lease);
    if (state?.owner === this) state.current = false;
  }

  bindingIsCurrent(lease: CredentialBindingLease): boolean {
    return bindingLeaseIsCurrentForBroker(this, lease);
  }

  protected brokerDeadlineLimits(): { readonly maxDurationMs: number; readonly maxIdleMs: number } {
    return {
      maxDurationMs: BROKER_LIMITS.maxStreamDurationMs,
      maxIdleMs: BROKER_LIMITS.maxIdleMs,
    };
  }

  async exchange(request: AuthorizedProviderRequest): Promise<BrokerStreamResponse> {
    const destination = authorizeProviderRequest(request);
    const assertBindingCurrent = () => {
      if (!bindingLeaseIsCurrentForBroker(this, destination.binding)) {
        throw createCredentialBrokerError({
          reasonCode: "credential_unavailable",
          retryable: false,
          audience: destination.audience,
          requestId: destination.requestId,
          attemptId: destination.attemptId,
          providerId: destination.providerId,
          modelId: destination.modelId,
          statusClass: "credential",
        });
      }
    };
    assertBindingCurrent();
    const attempt = beginBrokerTransportAttempt(destination);
    const limits = this.brokerDeadlineLimits();
    const dispatchStartedAt = performance.now();
    const totalDeadline = dispatchStartedAt + limits.maxDurationMs;
    const initialIdleDeadline = dispatchStartedAt + limits.maxIdleMs;
    const exchangeController = new AbortController();
    const forwardAbort = () => exchangeController.abort();
    if (nativeSignalAborted(destination.signal)) forwardAbort();
    else addNativeAbortListener(destination.signal, forwardAbort);
    const monitor: BrokerAttemptMonitor = Object.freeze({
      recordRequestBodyBytes: (byteCount: number) => recordBrokerRequestBodyBytes(attempt, byteCount),
      requestBodyBytesWritten: () => brokerRequestBodyBytesWritten(attempt),
      assertBindingCurrent,
      failure: (
        reasonCode: Parameters<BrokerAttemptMonitor["failure"]>[0],
        statusClass: Parameters<BrokerAttemptMonitor["failure"]>[1],
      ) => createCredentialBrokerError({
        reasonCode,
        retryable: false,
        audience: destination.audience,
        requestId: destination.requestId,
        attemptId: destination.attemptId,
        providerId: destination.providerId,
        modelId: destination.modelId,
        statusClass,
      }),
      signal: exchangeController.signal,
      dispatchStartedAt,
      totalDeadline,
      initialIdleDeadline,
    });
    const timeoutCode = limits.maxIdleMs <= limits.maxDurationMs ? "idle_timeout" : "duration_exceeded";
    const timeoutMs = Math.min(limits.maxDurationMs, limits.maxIdleMs) + 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: PrivilegedBrokerExchangeResult;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          exchangeController.abort();
          reject(createCredentialBrokerError({
            reasonCode: timeoutCode,
            retryable: false,
            audience: destination.audience,
            requestId: destination.requestId,
            attemptId: destination.attemptId,
            providerId: destination.providerId,
            modelId: destination.modelId,
            statusClass: "bounds",
          }));
        }, timeoutMs);
        timeout.unref?.();
      });
      result = await Promise.race([this.exchangeAuthorized(destination, monitor), deadline]);
    } catch (error) {
      if (credentialBrokerErrorMatchesInvocation(error, destination) &&
        !error.retryable) {
        throw error;
      }
      const reasonCode: CredentialBrokerErrorCode = !bindingLeaseIsCurrentForBroker(this, destination.binding)
        ? "credential_unavailable"
        : nativeSignalAborted(destination.signal)
          ? "request_cancelled"
          : performance.now() > totalDeadline
          ? "duration_exceeded"
          : performance.now() > initialIdleDeadline
            ? "idle_timeout"
            : "outcome_unknown";
      throw createCredentialBrokerError({
        reasonCode,
        retryable: false,
        audience: destination.audience,
        requestId: destination.requestId,
        attemptId: destination.attemptId,
        providerId: destination.providerId,
        modelId: destination.modelId,
        statusClass: reasonCode === "credential_unavailable"
          ? "credential"
          : reasonCode === "request_cancelled"
          ? "cancelled"
          : reasonCode === "outcome_unknown" ? "outcome_unknown" : "bounds",
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      removeNativeAbortListener(destination.signal, forwardAbort);
    }
    if (result.kind === "connect_failure_before_body") {
      throw classifyConnectFailureBeforeBody(attempt);
    }
    if (result.kind === "http_status_before_stream") {
      throw classifyHttpStatus(result.status, attempt);
    }
    return result.response;
  }

  protected abstract exchangeAuthorized(
    destination: AuthorizedBrokerDestination,
    monitor: BrokerAttemptMonitor,
  ): Promise<PrivilegedBrokerExchangeResult>;
}

function classifyHttpStatus(
  status: unknown,
  attempt: BrokerTransportAttempt,
): CredentialBrokerError {
  const identity = {
    audience: attempt.audience,
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
  };
  if (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599) {
    return createCredentialBrokerError({
      reasonCode: "invalid_response",
      retryable: false,
      ...identity,
      statusClass: "response_invalid",
    });
  }
  if ((status as number) >= 300 && (status as number) < 400) {
    return createCredentialBrokerError({
      reasonCode: "redirect_blocked",
      retryable: false,
      ...identity,
      statusClass: "redirect",
    });
  }
  if ((RETRYABLE_HTTP_STATUSES as readonly number[]).includes(status as number)) {
    return createCredentialBrokerError({
      reasonCode: "http_retryable_before_stream",
      retryable: true,
      ...identity,
      statusClass: "http_retryable",
    });
  }
  return createCredentialBrokerError({
    reasonCode: "http_non_retryable",
    retryable: false,
    ...identity,
    statusClass: "http_non_retryable",
  });
}

export function generatedHeaderBytes(headers: Readonly<Record<string, string>>): number {
  return Object.entries(headers).reduce(
    (total, [name, value]) => total + new TextEncoder().encode(`${name}:${value}\r\n`).byteLength,
    0,
  );
}
