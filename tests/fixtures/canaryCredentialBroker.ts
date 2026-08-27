import {
  addNativeAbortListener,
  BROKER_DESTINATIONS,
  BROKER_LIMITS,
  CREDENTIAL_AUDIENCES,
  CredentialBrokerError,
  generatedHeaderBytes,
  nativeSignalAborted,
  removeNativeAbortListener,
  PrivilegedCredentialBroker,
  type AuthorizedBrokerDestination,
  type AuthorizedProviderRequest,
  type BrokerAttemptMonitor,
  type BrokerStreamResponse,
  type CredentialAudience,
  type CredentialBindingLease,
  type PrivilegedBrokerExchangeResult,
  type ProviderRoute,
} from "../../src/providers/credentialBroker";

export interface CanaryBrokerChunk {
  readonly bytes: string | Uint8Array;
  readonly delayMs?: number;
}

export interface CanaryResponseHeader {
  readonly name: string;
  readonly value: string;
}

export interface CanaryBrokerScript {
  readonly audience: CredentialAudience;
  readonly route: ProviderRoute;
  readonly status?: number;
  readonly responseHeaders?: readonly CanaryResponseHeader[];
  readonly headerDelayMs?: number;
  readonly chunks?: readonly CanaryBrokerChunk[];
  readonly failure?: "connect_failure_before_body" | "outcome_unknown";
  readonly bodyFailureAtChunk?: number;
  readonly cleanup?: "normal" | "reject" | "hang";
  readonly cleanupDelayMs?: number;
}

export interface CanaryBrokerObservation {
  readonly requestId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly audience: CredentialAudience;
  readonly route: ProviderRoute;
  readonly origin: string;
  readonly path: string;
  readonly method: "POST";
  readonly bodyBytes: number;
  readonly bodyBytesWritten: number;
  readonly generatedHeaderBytes: number;
  readonly redirect: "error";
  readonly automaticRetries: 0;
  readonly ambientProxy: "disabled";
  readonly credentialAttached: true;
}

interface StoredCredential {
  readonly lease: CredentialBindingLease;
  readonly canary: string;
}

function rawBrokerError(input: {
  readonly reasonCode: ConstructorParameters<typeof CredentialBrokerError>[0]["reasonCode"];
  readonly audience: CredentialAudience;
  readonly requestId: string;
  readonly statusClass: ConstructorParameters<typeof CredentialBrokerError>[0]["statusClass"];
  readonly retryable?: boolean;
}): CredentialBrokerError {
  return new CredentialBrokerError({
    ...input,
    retryable: input.retryable ?? false,
  });
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || haystack.byteLength < needle.byteLength) return false;
  outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function valueContainsCanary(
  value: unknown,
  canary: string,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return value.includes(canary);
  if (value === null || value === undefined ||
    typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return false;
  }
  if (typeof value === "symbol") return (value.description ?? "").includes(canary);
  if (typeof value === "function") return value.name.includes(canary);
  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);
  const needle = new TextEncoder().encode(canary);
  if (value instanceof Uint8Array) return bytesContain(value, needle);
  if (value instanceof ArrayBuffer) return bytesContain(new Uint8Array(value), needle);
  if (ArrayBuffer.isView(value)) {
    return bytesContain(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), needle);
  }
  if (value instanceof Error && (
    value.name.includes(canary) || value.message.includes(canary) ||
    valueContainsCanary(value.cause, canary, seen)
  )) return true;

  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(object);
  } catch {
    return true;
  }
  for (const key of keys) {
    if (typeof key === "string" && key.includes(canary)) return true;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    } catch {
      return true;
    }
    if (!descriptor) continue;
    if ("value" in descriptor && valueContainsCanary(descriptor.value, canary, seen)) return true;
    if (descriptor.get && descriptor.get.name.includes(canary)) return true;
    if (descriptor.set && descriptor.set.name.includes(canary)) return true;
  }
  return false;
}

function collectStringChannels(
  value: unknown,
  output: Map<string, string[]>,
  path = "$",
  seen = new WeakSet<object>(),
): void {
  if (typeof value === "string") {
    const channel = output.get(path) ?? [];
    channel.push(value);
    output.set(path, channel);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (descriptor && "value" in descriptor) {
      const segment = typeof key === "string" && !/^\d+$/.test(key) ? key : "[]";
      collectStringChannels(descriptor.value, output, `${path}.${segment}`, seen);
    }
  }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
  requestId: string,
  audience: CredentialAudience,
): Promise<void> {
  if (nativeSignalAborted(signal)) {
    return Promise.reject(rawBrokerError({
      reasonCode: "request_cancelled",
      audience,
      requestId,
      statusClass: "cancelled",
    }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeNativeAbortListener(signal, onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(rawBrokerError({
      reasonCode: "request_cancelled",
      audience,
      requestId,
      statusClass: "cancelled",
    })));
    const timeout = setTimeout(() => settle(resolve), milliseconds);
    timeout.unref?.();
    addNativeAbortListener(signal, onAbort);
  });
}

function validateResponseHeaders(
  headers: readonly CanaryResponseHeader[],
  audience: CredentialAudience,
  requestId: string,
  maxHeaderBytes: number,
  failure: BrokerAttemptMonitor["failure"],
): void {
  let bytes = 0;
  const seen = new Set<string>();
  let contentType: string | undefined;
  let contentEncoding: string | undefined;
  for (const header of headers) {
    if (!header || typeof header.name !== "string" || typeof header.value !== "string" ||
      /[\r\n\0]/.test(header.name) || /[\r\n\0]/.test(header.value) ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) {
      throw failure("invalid_response_headers", "response_invalid");
    }
    const name = header.name.toLowerCase();
    if (seen.has(name) || ["transfer-encoding", "content-length", "connection"].includes(name)) {
      throw failure("invalid_response_headers", "response_invalid");
    }
    seen.add(name);
    bytes += new TextEncoder().encode(`${header.name}:${header.value}\r\n`).byteLength;
    if (name === "content-type") contentType = header.value;
    if (name === "content-encoding") contentEncoding = header.value;
  }
  if (bytes > maxHeaderBytes || !contentType) {
    throw failure("invalid_response_headers", "response_invalid");
  }
  const parts = contentType.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "text/event-stream" || parts.length > 2 ||
    (parts.length === 2 && parts[1] !== "charset=utf-8")) {
    throw failure("invalid_response_headers", "response_invalid");
  }
  if (contentEncoding !== undefined && contentEncoding.trim().toLowerCase() !== "identity") {
    throw failure("invalid_response_headers", "response_invalid");
  }
}

export interface TestCanaryBrokerLimits {
  readonly maxRequestHeaderBytes: number;
  readonly maxResponseHeaderBytes: number;
  readonly maxResponseBytes: number;
  readonly maxDurationMs: number;
  readonly maxIdleMs: number;
}

const DEFAULT_TEST_BROKER_LIMITS: TestCanaryBrokerLimits = Object.freeze({
  maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
  maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
  maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
  maxDurationMs: BROKER_LIMITS.maxStreamDurationMs,
  maxIdleMs: BROKER_LIMITS.maxIdleMs,
});

function validateTestBrokerLimits(value: unknown): TestCanaryBrokerLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid test broker limits.");
  }
  const keys = Object.keys(DEFAULT_TEST_BROKER_LIMITS).sort();
  if (Object.keys(value).sort().join(",") !== keys.join(",")) throw new Error("Invalid test broker limits.");
  const result: Record<string, number> = {};
  for (const key of keys as (keyof TestCanaryBrokerLimits)[]) {
    const item = (value as Record<string, unknown>)[key];
    if (!Number.isSafeInteger(item) || (item as number) < 1 ||
      (item as number) > DEFAULT_TEST_BROKER_LIMITS[key]) {
      throw new Error("Invalid test broker limits.");
    }
    result[key] = item as number;
  }
  return Object.freeze(result) as unknown as TestCanaryBrokerLimits;
}

export class TestCanaryCredentialBroker extends PrivilegedCredentialBroker {
  readonly #credentials = new Map<string, StoredCredential>();
  readonly #scripts: CanaryBrokerScript[] = [];
  readonly #observations: CanaryBrokerObservation[] = [];
  readonly #bodySnapshots: unknown[] = [];
  readonly #seenRequestIds = new Set<string>();
  #credentialAttachmentCount = 0;
  #transportAttemptCount = 0;
  #transportCloseCount = 0;

  readonly #limits: TestCanaryBrokerLimits;

  constructor(limits: TestCanaryBrokerLimits = DEFAULT_TEST_BROKER_LIMITS) {
    super();
    this.#limits = validateTestBrokerLimits(limits);
  }

  protected override brokerDeadlineLimits(): { readonly maxDurationMs: number; readonly maxIdleMs: number } {
    return {
      maxDurationMs: this.#limits.maxDurationMs,
      maxIdleMs: this.#limits.maxIdleMs,
    };
  }

  issueCredential(audience: CredentialAudience, canary: string): CredentialBindingLease {
    if (!CREDENTIAL_AUDIENCES.includes(audience) ||
      typeof canary !== "string" || canary.length < 16 || canary.length > 4096) {
      throw new Error("Test canaries must be bounded and use a reviewed audience.");
    }
    const lease = this.issueBindingLease(audience);
    this.#credentials.set(lease.bindingId, { lease, canary });
    return lease;
  }

  expireCredential(lease: CredentialBindingLease): void {
    this.invalidateBindingLease(lease);
  }

  rotateCredential(
    lease: CredentialBindingLease,
    canary: string,
    audience: CredentialAudience = lease.audience,
  ): CredentialBindingLease {
    this.invalidateBindingLease(lease);
    return this.issueCredential(audience, canary);
  }

  rotateCurrentCredential(
    audience: CredentialAudience,
    canary: string,
  ): CredentialBindingLease {
    const current = [...this.#credentials.values()].find(
      (credential) => credential.lease.audience === audience && this.bindingIsCurrent(credential.lease),
    );
    if (!current) throw new Error("No current credential binding for audience.");
    return this.rotateCredential(current.lease, canary, audience);
  }

  enqueue(script: CanaryBrokerScript): void {
    this.#scripts.push(Object.freeze({
      ...script,
      responseHeaders: Object.freeze([...(script.responseHeaders ?? [
        { name: "content-type", value: "text/event-stream" },
      ])].map((header) => Object.freeze({ ...header }))),
      chunks: Object.freeze([...(script.chunks ?? [])].map((chunk) => Object.freeze({ ...chunk }))),
    }));
  }

  observations(): readonly CanaryBrokerObservation[] {
    return Object.freeze(this.#observations.map((item) => Object.freeze({ ...item })));
  }

  bodySnapshots(): readonly unknown[] {
    return Object.freeze(this.#bodySnapshots.map((item) => structuredClone(item)));
  }

  diagnostics(): Readonly<Record<string, number>> {
    return Object.freeze({
      requestCount: this.#observations.length,
      credentialAttachmentCount: this.#credentialAttachmentCount,
      transportAttemptCount: this.#transportAttemptCount,
      transportCloseCount: this.#transportCloseCount,
      queuedResponseCount: this.#scripts.length,
    });
  }

  assertCanaryAbsent(value: unknown): void {
    for (const credential of this.#credentials.values()) {
      if (valueContainsCanary(value, credential.canary)) {
        throw new Error("A credential canary crossed the privileged broker boundary.");
      }
    }
  }

  protected async exchangeAuthorized(
    authorized: AuthorizedBrokerDestination,
    transportAttempt: BrokerAttemptMonitor,
  ): Promise<PrivilegedBrokerExchangeResult> {
    const brokerError = (input: Parameters<typeof rawBrokerError>[0]): CredentialBrokerError =>
      transportAttempt.failure(input.reasonCode as never, input.statusClass);
    const stored = this.#credentials.get(authorized.binding.bindingId);
    if (!stored || stored.lease.audience !== authorized.audience) {
      throw brokerError({
        reasonCode: "credential_unavailable",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "credential",
      });
    }
    if (this.#seenRequestIds.has(authorized.requestId)) {
      throw brokerError({
        reasonCode: "request_replayed",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "request_rejected",
      });
    }
    this.#seenRequestIds.add(authorized.requestId);
    try {
      this.assertCanaryAbsent(authorized.canonicalBody);
    } catch {
      throw brokerError({
        reasonCode: "secret_reflection_blocked",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "request_rejected",
      });
    }
    if (nativeSignalAborted(authorized.signal)) {
      throw brokerError({
        reasonCode: "request_cancelled",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "cancelled",
      });
    }

    const policy = BROKER_DESTINATIONS[authorized.route];
    transportAttempt.assertBindingCurrent();
    const finalHeaders: Record<string, string> = {
      ...policy.generatedPublicHeaders,
      [policy.credentialHeader]: policy.credentialHeader === "authorization"
        ? `Bearer ${stored.canary}`
        : stored.canary,
      ...(authorized.audience === "openai" ? { "x-client-request-id": authorized.requestId } : {}),
    };
    const headerBytes = generatedHeaderBytes(finalHeaders);
    if (headerBytes > this.#limits.maxRequestHeaderBytes) {
      throw brokerError({
        reasonCode: "request_headers_too_large",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "bounds",
      });
    }
    this.#credentialAttachmentCount += 1;
    this.#transportAttemptCount += 1;
    const script = this.#scripts.shift();
    const beforeBodyFailure = script?.failure === "connect_failure_before_body";
    if (!beforeBodyFailure) {
      transportAttempt.recordRequestBodyBytes(authorized.canonicalBody.byteLength);
    }
    const bodyBytesWritten = transportAttempt.requestBodyBytesWritten();
    if (!beforeBodyFailure) this.#bodySnapshots.push(structuredClone(authorized.parsedBody));
    this.#observations.push(Object.freeze({
      requestId: authorized.requestId,
      attemptId: authorized.attemptId,
      providerId: authorized.providerId,
      modelId: authorized.modelId,
      audience: authorized.audience,
      route: authorized.route,
      origin: authorized.origin,
      path: authorized.path,
      method: authorized.method,
      bodyBytes: authorized.canonicalBody.byteLength,
      bodyBytesWritten,
      generatedHeaderBytes: headerBytes,
      redirect: authorized.redirect,
      automaticRetries: authorized.automaticRetries,
      ambientProxy: authorized.ambientProxy,
      credentialAttached: true,
    }));

    if (!script || script.audience !== authorized.audience || script.route !== authorized.route) {
      throw brokerError({
        reasonCode: "outcome_unknown",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "outcome_unknown",
      });
    }
    if (script.failure === "connect_failure_before_body") {
      return { kind: "connect_failure_before_body" };
    }
    if (script.failure === "outcome_unknown") {
      throw brokerError({
        reasonCode: "outcome_unknown",
        audience: authorized.audience,
        requestId: authorized.requestId,
        statusClass: "outcome_unknown",
      });
    }
    const status = script.status ?? 200;
    if (status !== 200) return { kind: "http_status_before_stream", status };
    if (script.headerDelayMs !== undefined) {
      if (!Number.isSafeInteger(script.headerDelayMs) || script.headerDelayMs < 0) {
        throw brokerError({
          reasonCode: "invalid_response_headers",
          audience: authorized.audience,
          requestId: authorized.requestId,
          statusClass: "response_invalid",
        });
      }
      try {
        await abortableDelay(script.headerDelayMs, transportAttempt.signal, authorized.requestId, authorized.audience);
      } catch (error) {
        this.#transportCloseCount += 1;
        throw error;
      }
    }
    validateResponseHeaders(
      script.responseHeaders ?? [],
      authorized.audience,
      authorized.requestId,
      this.#limits.maxResponseHeaderBytes,
      transportAttempt.failure,
    );

    const chunks = script.chunks ?? [];
    const responseCanaries = [...new Set([
      stored.canary,
      ...[...this.#credentials.values()].map((credential) => credential.canary),
    ])];
    const canaryBytes = responseCanaries.map((canary) => new TextEncoder().encode(canary));
    const retainedBytes = Math.max(0, ...canaryBytes.map((value) => value.byteLength - 1));
    const decodedChannelSuffixes = new Map<string, string>();
    const decodedOutputHoldbacks = new Map<string, string>();
    const maxCanaryCharacters = Math.max(...responseCanaries.map((canary) => canary.length));
    const signal = authorized.signal;
    const requestId = authorized.requestId;
    const audience = authorized.audience;
    let chunkIndex = 0;
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let rawBytes = 0;
    let flushed = false;
    let closed = false;
    const totalDeadline = transportAttempt.totalDeadline;
    let idleDeadline = transportAttempt.initialIdleDeadline;
    const maxResponseBytes = this.#limits.maxResponseBytes;

    const assertCredentialAbsent = (value: unknown) => {
      const currentChannels = new Map<string, string[]>();
      collectStringChannels(value, currentChannels);
      for (const canary of responseCanaries) {
        if (valueContainsCanary(value, canary) || [...currentChannels].some(
          ([path, parts]) => `${decodedChannelSuffixes.get(path) ?? ""}${parts.join("")}`.includes(canary),
        )) {
          throw brokerError({
            reasonCode: "secret_reflection_blocked",
            audience,
            requestId,
            statusClass: "request_rejected",
          });
        }
      }
      const retained = Math.max(0, maxCanaryCharacters - 1);
      for (const [path, parts] of currentChannels) {
        const combined = `${decodedChannelSuffixes.get(path) ?? ""}${parts.join("")}`;
        decodedChannelSuffixes.set(path, retained === 0 ? "" : combined.slice(-retained));
      }
    };
    const quarantineDecoded = (channel: string, value: string, final = false): string => {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(channel) || typeof value !== "string") {
        throw brokerError({
          reasonCode: "invalid_response",
          audience,
          requestId,
          statusClass: "response_invalid",
        });
      }
      const combined = `${decodedOutputHoldbacks.get(channel) ?? ""}${value}`;
      for (const canary of responseCanaries) {
        if (combined.includes(canary)) {
          decodedOutputHoldbacks.delete(channel);
          throw brokerError({
            reasonCode: "secret_reflection_blocked",
            audience,
            requestId,
            statusClass: "request_rejected",
          });
        }
      }
      if (final) {
        decodedOutputHoldbacks.delete(channel);
        return combined;
      }
      const retain = Math.max(0, maxCanaryCharacters - 1);
      const releaseLength = Math.max(0, combined.length - retain);
      const released = combined.slice(0, releaseLength);
      decodedOutputHoldbacks.set(channel, combined.slice(releaseLength));
      return released;
    };

    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        if (closed) return { done: true, value: undefined };
        try {
          for (;;) {
          const beforeRead = performance.now();
          if (beforeRead > totalDeadline) {
            throw brokerError({ reasonCode: "duration_exceeded", audience, requestId, statusClass: "bounds" });
          }
          if (beforeRead > idleDeadline) {
            throw brokerError({ reasonCode: "idle_timeout", audience, requestId, statusClass: "bounds" });
          }
          if (nativeSignalAborted(signal)) {
            throw brokerError({ reasonCode: "request_cancelled", audience, requestId, statusClass: "cancelled" });
          }
          if (script.bodyFailureAtChunk === chunkIndex) {
            throw brokerError({ reasonCode: "outcome_unknown", audience, requestId, statusClass: "outcome_unknown" });
          }
          if (chunkIndex >= chunks.length) {
            if (!flushed && pending.byteLength > 0) {
              flushed = true;
              const value = pending;
              pending = new Uint8Array();
              return { done: false, value };
            }
            return { done: true, value: undefined };
          }
          const chunk = chunks[chunkIndex];
          chunkIndex += 1;
          if (chunk.delayMs !== undefined) {
            if (!Number.isSafeInteger(chunk.delayMs) || chunk.delayMs < 0) {
              throw brokerError({ reasonCode: "invalid_response", audience, requestId, statusClass: "response_invalid" });
            }
            const now = performance.now();
            const boundRemaining = Math.min(totalDeadline - now, idleDeadline - now);
            if (boundRemaining <= 0) {
              throw brokerError({
                reasonCode: totalDeadline <= idleDeadline ? "duration_exceeded" : "idle_timeout",
                audience,
                requestId,
                statusClass: "bounds",
              });
            }
            if (chunk.delayMs > boundRemaining) {
              await abortableDelay(Math.max(0, Math.ceil(boundRemaining)), signal, requestId, audience);
              throw brokerError({
                reasonCode: totalDeadline <= idleDeadline ? "duration_exceeded" : "idle_timeout",
                audience,
                requestId,
                statusClass: "bounds",
              });
            }
            await abortableDelay(chunk.delayMs, signal, requestId, audience);
          }
          const bytes = typeof chunk.bytes === "string"
            ? new TextEncoder().encode(chunk.bytes)
            : new Uint8Array(chunk.bytes);
          if (bytes.byteLength === 0) {
            throw brokerError({ reasonCode: "invalid_response", audience, requestId, statusClass: "response_invalid" });
          }
          rawBytes += bytes.byteLength;
          if (rawBytes > maxResponseBytes) {
            throw brokerError({ reasonCode: "response_too_large", audience, requestId, statusClass: "bounds" });
          }
          idleDeadline = performance.now() + this.#limits.maxIdleMs;
          pending = appendBytes(pending, bytes);
          if (canaryBytes.some((canary) => bytesContain(pending, canary))) {
            throw brokerError({ reasonCode: "secret_reflection_blocked", audience, requestId, statusClass: "request_rejected" });
          }
          const releasable = Math.max(0, pending.byteLength - retainedBytes);
          if (releasable > 0) {
            const value = pending.slice(0, releasable);
            pending = pending.slice(releasable);
            return { done: false, value };
          }
          }
        } catch (error) {
          if (!closed) {
            closed = true;
            pending = new Uint8Array();
            this.#transportCloseCount += 1;
          }
          if (error instanceof CredentialBrokerError) throw error;
          throw brokerError({
            reasonCode: "invalid_response",
            audience,
            requestId,
            statusClass: "response_invalid",
          });
        }
      },
      return: async () => {
        if (closed) return { done: true, value: undefined };
        closed = true;
        this.#transportCloseCount += 1;
        if (script.cleanupDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, script.cleanupDelayMs));
        }
        if (script.cleanup === "reject") throw new Error("hostile cleanup detail");
        if (script.cleanup === "hang") return await new Promise(() => undefined);
        return { done: true, value: undefined };
      },
    };

    const body: AsyncIterable<Uint8Array> = Object.freeze({
      [Symbol.asyncIterator]: () => iterator,
    });
    return {
      kind: "response",
      response: Object.freeze({
        requestId,
        attemptId: authorized.attemptId,
        providerId: authorized.providerId,
        modelId: authorized.modelId,
        audience,
        body,
        assertCredentialAbsent,
        quarantineDecoded,
      }),
    };
  }
}

export type BrokerResponseFaultTarget = "assertCredentialAbsent" | "quarantineDecoded" | "body";

export class FaultingCanaryCredentialBroker extends TestCanaryCredentialBroker {
  constructor(
    private readonly target: BrokerResponseFaultTarget,
    private readonly createFault: () => unknown,
  ) {
    super();
  }

  override async exchange(request: AuthorizedProviderRequest): Promise<BrokerStreamResponse> {
    const response = await super.exchange(request);
    if (this.target === "assertCredentialAbsent") {
      return Object.freeze({
        ...response,
        assertCredentialAbsent: () => { throw this.createFault(); },
      });
    }
    if (this.target === "quarantineDecoded") {
      return Object.freeze({
        ...response,
        quarantineDecoded: () => { throw this.createFault(); },
      });
    }
    const body: AsyncIterable<Uint8Array> = Object.freeze({
      [Symbol.asyncIterator]: () => {
        const upstream = response.body[Symbol.asyncIterator]();
        return {
          next: async () => { throw this.createFault(); },
          return: async () => upstream.return
            ? await upstream.return()
            : { done: true as const, value: undefined },
        };
      },
    });
    return Object.freeze({ ...response, body });
  }
}
