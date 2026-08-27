import { canonicalStringify, type JsonValue } from "../domain/canonical";
import {
  addNativeAbortListener,
  CREDENTIAL_AUDIENCES,
  isNativeAbortSignal,
  nativeSignalAborted,
  normalizeProviderRequestId,
  removeNativeAbortListener,
  type CredentialAudience,
} from "./credentialBroker";
import { parseStrictJson, StrictJsonError } from "./strictJson";

export interface ProviderStreamLimits {
  readonly maxLineBytes: number;
  readonly maxEventBytes: number;
  readonly maxResponseBytes: number;
  readonly maxTextBytes: number;
  readonly maxToolArgumentBytes: number;
  readonly maxEvents: number;
  readonly maxIdBytes: number;
  readonly maxJsonDepth: number;
  readonly maxDurationMs: number;
  readonly maxIdleMs: number;
  readonly maxCleanupMs: number;
}

export const DEFAULT_PROVIDER_STREAM_LIMITS: ProviderStreamLimits = Object.freeze({
  maxLineBytes: 1024 * 1024,
  maxEventBytes: 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxTextBytes: 8 * 1024 * 1024,
  maxToolArgumentBytes: 1024 * 1024,
  maxEvents: 100_000,
  maxIdBytes: 512,
  maxJsonDepth: 64,
  maxDurationMs: 600_000,
  maxIdleMs: 30_000,
  maxCleanupMs: 1_000,
});

export type ProviderStreamBoundaryCode =
  | "invalid_limits"
  | "invalid_request_id"
  | "event_line_too_large"
  | "event_too_large"
  | "response_too_large"
  | "text_too_large"
  | "too_many_events"
  | "duration_exceeded"
  | "idle_timeout"
  | "malformed_sse"
  | "malformed_utf8"
  | "utf8_bom_forbidden"
  | "malformed_json"
  | "duplicate_json_key"
  | "json_depth_exceeded"
  | "request_cancelled"
  | "upstream_stream_failure"
  | "cleanup_failed"
  | "secret_reflection_blocked"
  | "tool_arguments_too_large"
  | "tool_arguments_malformed"
  | "invalid_provider_id"
  | "invalid_usage";

const STREAM_CODES = new Set<ProviderStreamBoundaryCode>([
  "invalid_limits",
  "invalid_request_id",
  "event_line_too_large",
  "event_too_large",
  "response_too_large",
  "text_too_large",
  "too_many_events",
  "duration_exceeded",
  "idle_timeout",
  "malformed_sse",
  "malformed_utf8",
  "utf8_bom_forbidden",
  "malformed_json",
  "duplicate_json_key",
  "json_depth_exceeded",
  "request_cancelled",
  "upstream_stream_failure",
  "cleanup_failed",
  "secret_reflection_blocked",
  "tool_arguments_too_large",
  "tool_arguments_malformed",
  "invalid_provider_id",
  "invalid_usage",
]);

export function normalizeProviderStreamBoundaryCode(value: unknown): ProviderStreamBoundaryCode | undefined {
  return typeof value === "string" && STREAM_CODES.has(value as ProviderStreamBoundaryCode)
    ? value as ProviderStreamBoundaryCode
    : undefined;
}

export class ProviderStreamBoundaryError extends Error {
  readonly reasonCode: ProviderStreamBoundaryCode;
  readonly audience: CredentialAudience | "unknown";
  readonly requestId: string;
  readonly retryable = false;

  constructor(
    reasonCodeValue: ProviderStreamBoundaryCode,
    requestIdValue: string,
    audienceValue: CredentialAudience | "unknown" = "unknown",
  ) {
    const reasonCode = STREAM_CODES.has(reasonCodeValue) ? reasonCodeValue : "malformed_sse";
    const requestId = normalizeProviderRequestId(requestIdValue);
    const audience = audienceValue === "unknown" || CREDENTIAL_AUDIENCES.includes(audienceValue)
      ? audienceValue
      : "unknown";
    super(`Provider stream ${requestId} stopped (${reasonCode}).`);
    this.name = "ProviderStreamBoundaryError";
    this.reasonCode = reasonCode;
    this.requestId = requestId;
    this.audience = audience;
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

export type SseFrame =
  | { readonly kind: "comment"; readonly rawBytes: number }
  | {
      readonly kind: "event";
      readonly event?: string;
      readonly data: string;
      readonly rawBytes: number;
    };

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateProviderStreamLimits(value: unknown): ProviderStreamLimits {
  try {
    if (!plainRecord(value)) throw new Error("invalid");
    const expected = Object.keys(DEFAULT_PROVIDER_STREAM_LIMITS).sort();
    const actual = Object.keys(value).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error("invalid");
    }
    const result: Record<string, number> = {};
    for (const key of expected as (keyof ProviderStreamLimits)[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("invalid");
      const item = descriptor.value;
      if (!Number.isSafeInteger(item) || item < 1 || item > DEFAULT_PROVIDER_STREAM_LIMITS[key]) {
        throw new Error("invalid");
      }
      result[key] = item;
    }
    return Object.freeze(result) as unknown as ProviderStreamLimits;
  } catch {
    throw new ProviderStreamBoundaryError("invalid_limits", "request-preflight");
  }
}

function boundary(
  reasonCode: ProviderStreamBoundaryCode,
  requestId: string,
  audience: CredentialAudience,
): ProviderStreamBoundaryError {
  const error = new ProviderStreamBoundaryError(reasonCode, requestId, audience);
  return Object.freeze(error);
}

function monotonicNow(): number {
  return performance.now();
}

async function nextWithBounds(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  totalDeadline: number,
  idleDeadline: number,
  issue: (reasonCode: ProviderStreamBoundaryCode) => ProviderStreamBoundaryError,
  mapTrustedError?: (error: unknown) => ProviderStreamBoundaryCode | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (nativeSignalAborted(signal)) throw issue("request_cancelled");
  const now = monotonicNow();
  if (now > totalDeadline) throw issue("duration_exceeded");
  if (now > idleDeadline) throw issue("idle_timeout");
  const totalRemaining = totalDeadline - now;
  const idleRemaining = idleDeadline - now;
  const timeoutMs = Math.max(0, Math.min(totalRemaining, idleRemaining));
  const timeoutCode: ProviderStreamBoundaryCode = idleRemaining <= totalRemaining
    ? "idle_timeout"
    : "duration_exceeded";

  return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const settle = (callback: (value: never) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeNativeAbortListener(signal, onAbort);
      callback(value as never);
    };
    const onAbort = () => settle(reject, issue("request_cancelled"));
    const timeout = setTimeout(
      () => settle(reject, issue(timeoutCode)),
      timeoutMs + 1,
    );
    timeout.unref?.();
    addNativeAbortListener(signal, onAbort);

    let pending: PromiseLike<IteratorResult<Uint8Array>> | IteratorResult<Uint8Array>;
    try {
      pending = iterator.next();
    } catch {
      settle(reject, issue("upstream_stream_failure"));
      return;
    }
    void Promise.resolve(pending).then(
      (value) => settle(resolve as (value: never) => void, value),
      (error) => {
        let mapped: ProviderStreamBoundaryCode | undefined;
        try {
          mapped = mapTrustedError?.(error);
          if (mapped !== undefined && !STREAM_CODES.has(mapped)) mapped = undefined;
        } catch {
          mapped = undefined;
        }
        settle(reject, issue(mapped ?? "upstream_stream_failure"));
      },
    );
  });
}

async function cleanupIterator(
  iterator: AsyncIterator<Uint8Array>,
  timeoutMs: number,
): Promise<boolean> {
  let returnIterator: AsyncIterator<Uint8Array>["return"];
  try {
    returnIterator = iterator.return;
  } catch {
    return false;
  }
  if (!returnIterator) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const cleanup = Promise.resolve(returnIterator.call(iterator)).then(
      () => true,
      () => false,
    );
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

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return new Uint8Array(right);
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

function lineFeedIndex(buffer: Uint8Array): number {
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] === 0x0a) return index;
  }
  return -1;
}

function decodeLine(
  bytes: Uint8Array,
  issue: (reasonCode: ProviderStreamBoundaryCode) => ProviderStreamBoundaryError,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw issue("malformed_utf8");
  }
}

function validRequestContext(
  requestIdValue: unknown,
  audienceValue: unknown,
): { readonly requestId: string; readonly audience: CredentialAudience } {
  const requestId = normalizeProviderRequestId(requestIdValue);
  if (requestId === "request-invalid") {
    throw new ProviderStreamBoundaryError("invalid_request_id", requestId, "unknown");
  }
  if (typeof audienceValue !== "string" ||
    !CREDENTIAL_AUDIENCES.includes(audienceValue as CredentialAudience)) {
    throw new ProviderStreamBoundaryError("invalid_provider_id", requestId, "unknown");
  }
  return { requestId, audience: audienceValue as CredentialAudience };
}

export async function* parseSseByteStream(
  source: AsyncIterable<Uint8Array>,
  limitsValue: ProviderStreamLimits,
  signalValue: AbortSignal,
  requestIdValue: string,
  audienceValue: CredentialAudience,
  mapTrustedError?: (error: unknown) => ProviderStreamBoundaryCode | undefined,
): AsyncIterable<SseFrame> {
  const { requestId, audience } = validRequestContext(requestIdValue, audienceValue);
  const limits = validateProviderStreamLimits(limitsValue);
  if (!isNativeAbortSignal(signalValue)) throw boundary("request_cancelled", requestId, audience);
  const signal = signalValue;
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch {
    throw boundary("upstream_stream_failure", requestId, audience);
  }

  const startedAt = monotonicNow();
  const totalDeadline = startedAt + limits.maxDurationMs;
  let idleDeadline = startedAt + limits.maxIdleMs;
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let responseBytes = 0;
  let eventCount = 0;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let eventWireBytes = 0;
  let receivedPrefix: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let primaryError: ProviderStreamBoundaryError | undefined;
  const invocationErrors = new WeakSet<ProviderStreamBoundaryError>();
  const issue = (reasonCode: ProviderStreamBoundaryCode): ProviderStreamBoundaryError => {
    const error = boundary(reasonCode, requestId, audience);
    invocationErrors.add(error);
    return error;
  };

  const countEvent = () => {
    eventCount += 1;
    if (eventCount > limits.maxEvents) throw issue("too_many_events");
  };
  const resetEvent = () => {
    eventName = undefined;
    dataLines = [];
    eventWireBytes = 0;
  };

  try {
    for (;;) {
      const next = await nextWithBounds(
        iterator,
        signal,
        totalDeadline,
        idleDeadline,
        issue,
        mapTrustedError,
      );
      if (next.done) break;
      if (nativeSignalAborted(signal)) throw issue("request_cancelled");
      if (!(next.value instanceof Uint8Array)) {
        throw issue("upstream_stream_failure");
      }
      if (next.value.byteLength === 0) throw issue("upstream_stream_failure");
      const receivedAt = monotonicNow();
      if (receivedAt > totalDeadline) throw issue("duration_exceeded");
      idleDeadline = receivedAt + limits.maxIdleMs;
      responseBytes += next.value.byteLength;
      if (responseBytes > limits.maxResponseBytes) {
        throw issue("response_too_large");
      }
      if (next.value.includes(0x00)) throw issue("malformed_sse");
      if (receivedPrefix.byteLength < 3) {
        const needed = 3 - receivedPrefix.byteLength;
        receivedPrefix = appendBytes(receivedPrefix, next.value.slice(0, needed));
        if (receivedPrefix.byteLength >= 3 &&
          receivedPrefix[0] === 0xef && receivedPrefix[1] === 0xbb && receivedPrefix[2] === 0xbf) {
          throw issue("utf8_bom_forbidden");
        }
      }
      buffer = appendBytes(buffer, next.value);

      for (;;) {
        if (monotonicNow() > totalDeadline) {
          throw issue("duration_exceeded");
        }
        const lineEnd = lineFeedIndex(buffer);
        if (lineEnd < 0) {
          if (buffer.byteLength > limits.maxLineBytes + 1) {
            throw issue("event_line_too_large");
          }
          break;
        }
        const rawLine = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        const crlf = rawLine.byteLength > 0 && rawLine[rawLine.byteLength - 1] === 0x0d;
        const lineBytes = crlf ? rawLine.slice(0, -1) : rawLine;
        if (lineBytes.includes(0x0d)) throw issue("malformed_sse");
        if (lineBytes.byteLength > limits.maxLineBytes) {
          throw issue("event_line_too_large");
        }
        const terminatorBytes = crlf ? 2 : 1;

        if (lineBytes.byteLength === 0) {
          if (eventName === undefined && dataLines.length === 0) {
            resetEvent();
            continue;
          }
          if (dataLines.length === 0) throw issue("malformed_sse");
          const data = dataLines.join("\n");
          if (eventName === undefined && data !== "[DONE]") {
            throw issue("malformed_sse");
          }
          const assembledBytes = new TextEncoder().encode(`${eventName ?? ""}${data}`).byteLength;
          const rawBytes = eventWireBytes + terminatorBytes;
          if (assembledBytes > limits.maxEventBytes || rawBytes > limits.maxEventBytes) {
            throw issue("event_too_large");
          }
          countEvent();
          const frame = Object.freeze({
            kind: "event" as const,
            ...(eventName === undefined ? {} : { event: eventName }),
            data,
            rawBytes,
          });
          resetEvent();
          if (nativeSignalAborted(signal)) throw issue("request_cancelled");
          if (monotonicNow() > totalDeadline) {
            throw issue("duration_exceeded");
          }
          yield frame;
          continue;
        }

        const line = decodeLine(lineBytes, issue);
        if (line.startsWith(":")) {
          countEvent();
          if (nativeSignalAborted(signal)) throw issue("request_cancelled");
          if (monotonicNow() > totalDeadline) {
            throw issue("duration_exceeded");
          }
          yield Object.freeze({
            kind: "comment" as const,
            rawBytes: lineBytes.byteLength + terminatorBytes,
          });
          continue;
        }

        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? "" : line.slice(separator + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field !== "event" && field !== "data") {
          throw issue("malformed_sse");
        }
        if (field === "event") {
          if (eventName !== undefined || value.length === 0) {
            throw issue("malformed_sse");
          }
          eventName = value;
        } else {
          dataLines.push(value);
        }
        eventWireBytes += lineBytes.byteLength + terminatorBytes;
        if (eventWireBytes > limits.maxEventBytes) {
          throw issue("event_too_large");
        }
      }
    }

    if (buffer.byteLength !== 0 || eventName !== undefined || dataLines.length !== 0) {
      throw issue("malformed_sse");
    }
    if (nativeSignalAborted(signal)) throw issue("request_cancelled");
    if (monotonicNow() > totalDeadline) throw issue("duration_exceeded");
  } catch (error) {
    // No error supplied by the iterator, abort reason, or hostile object is
    // trusted. Internal state determines the stable class below.
    primaryError = primaryError ?? (
      invocationErrors.has(error as ProviderStreamBoundaryError)
        ? error as ProviderStreamBoundaryError
        : boundary(
            nativeSignalAborted(signal) ? "request_cancelled" : "upstream_stream_failure",
            requestId,
            audience,
          )
    );
    throw primaryError;
  } finally {
    const cleaned = await cleanupIterator(iterator, limits.maxCleanupMs);
    if (!cleaned && !primaryError) {
      throw issue("cleanup_failed");
    }
  }
  if (nativeSignalAborted(signal)) throw issue("request_cancelled");
}

function mapStrictJsonError(error: StrictJsonError): ProviderStreamBoundaryCode {
  if (error.reasonCode === "duplicate_json_key") return "duplicate_json_key";
  if (error.reasonCode === "json_depth_exceeded") return "json_depth_exceeded";
  if (error.reasonCode === "invalid_utf8") return "malformed_utf8";
  if (error.reasonCode === "utf8_bom_forbidden") return "utf8_bom_forbidden";
  return "malformed_json";
}

export function parseEventJson(
  frame: SseFrame,
  limitsValue: ProviderStreamLimits,
  requestIdValue: string,
  audienceValue: CredentialAudience,
): Readonly<Record<string, JsonValue>> {
  const { requestId, audience } = validRequestContext(requestIdValue, audienceValue);
  const limits = validateProviderStreamLimits(limitsValue);
  if (frame.kind !== "event" || !frame.event || frame.data === "[DONE]") {
    throw boundary("malformed_json", requestId, audience);
  }
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(frame.data, limits.maxJsonDepth);
  } catch (error) {
    throw boundary(
      error instanceof StrictJsonError ? mapStrictJsonError(error) : "malformed_json",
      requestId,
      audience,
    );
  }
  if (!plainRecord(parsed) || typeof parsed.type !== "string" || parsed.type !== frame.event) {
    throw boundary("malformed_json", requestId, audience);
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

export function parseBoundedToolArguments(
  serialized: unknown,
  limitsValue: ProviderStreamLimits,
  requestIdValue: string,
  audienceValue: CredentialAudience,
): JsonValue {
  const { requestId, audience } = validRequestContext(requestIdValue, audienceValue);
  const limits = validateProviderStreamLimits(limitsValue);
  if (typeof serialized !== "string") {
    throw boundary("tool_arguments_malformed", requestId, audience);
  }
  if (new TextEncoder().encode(serialized).byteLength > limits.maxToolArgumentBytes) {
    throw boundary("tool_arguments_too_large", requestId, audience);
  }
  try {
    const parsed = parseStrictJson(serialized, limits.maxJsonDepth);
    if (!plainRecord(parsed)) throw new Error("object required");
    return JSON.parse(canonicalStringify(parsed)) as JsonValue;
  } catch (error) {
    if (error instanceof StrictJsonError && error.reasonCode === "json_depth_exceeded") {
      throw boundary("json_depth_exceeded", requestId, audience);
    }
    if (error instanceof StrictJsonError && error.reasonCode === "duplicate_json_key") {
      throw boundary("duplicate_json_key", requestId, audience);
    }
    throw boundary("tool_arguments_malformed", requestId, audience);
  }
}

export class BoundedTextAccumulator {
  #value = "";
  #bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly requestId: string,
    private readonly audience: CredentialAudience,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      maxBytes > DEFAULT_PROVIDER_STREAM_LIMITS.maxTextBytes) {
      throw boundary("invalid_limits", requestId, audience);
    }
  }

  append(value: unknown): string {
    if (typeof value !== "string") throw boundary("malformed_json", this.requestId, this.audience);
    const bytes = new TextEncoder().encode(value).byteLength;
    if (this.#bytes + bytes > this.maxBytes) {
      throw boundary("text_too_large", this.requestId, this.audience);
    }
    this.#bytes += bytes;
    this.#value += value;
    return value;
  }

  value(): string {
    return this.#value;
  }

  byteLength(): number {
    return this.#bytes;
  }
}

export function validateProviderWireId(
  value: unknown,
  limitsValue: ProviderStreamLimits,
  requestIdValue: string,
  audienceValue: CredentialAudience,
): string {
  const { requestId, audience } = validRequestContext(requestIdValue, audienceValue);
  const limits = validateProviderStreamLimits(limitsValue);
  if (typeof value !== "string" || value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
    new TextEncoder().encode(value).byteLength > limits.maxIdBytes) {
    throw boundary("invalid_provider_id", requestId, audience);
  }
  return value;
}

export interface NormalizedProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export function validateProviderUsage(
  value: unknown,
  requestIdValue: string,
  audienceValue: CredentialAudience,
): NormalizedProviderUsage {
  const { requestId, audience } = validRequestContext(requestIdValue, audienceValue);
  try {
    if (!plainRecord(value)) throw new Error("invalid");
    const expected = ["inputTokens", "outputTokens", "totalTokens"] as const;
    if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
      throw new Error("invalid");
    }
    const snapshot: Record<(typeof expected)[number], number> = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
        throw new Error("invalid");
      }
      snapshot[key] = descriptor.value as number;
    }
    if (snapshot.totalTokens !== snapshot.inputTokens + snapshot.outputTokens) {
      throw new Error("invalid");
    }
    return Object.freeze(snapshot);
  } catch {
    throw boundary("invalid_usage", requestId, audience);
  }
}
