import { describe, expect, it } from "vitest";
import {
  BROKER_DESTINATIONS,
  BROKER_LIMITS,
  CredentialBrokerError,
  RETRYABLE_HTTP_STATUSES,
  authorizeProviderRequest,
  type AuthorizedProviderRequest,
  type CredentialAudience,
  type CredentialBindingLease,
  type ProviderRoute,
} from "../src/providers/credentialBroker";
import { canonicalJsonBytes, parseStrictJson } from "../src/providers/strictJson";
import { TestCanaryCredentialBroker } from "./fixtures/canaryCredentialBroker";

const CANARY = "bbb-canary-do-not-cross-1ef38c6d";

const ROUTES: Readonly<Record<CredentialAudience, ProviderRoute>> = Object.freeze({
  openai: "openai_responses",
  anthropic: "anthropic_messages",
  openrouter: "openrouter_responses",
});

function descriptor(
  credential: CredentialBindingLease,
  overrides: Partial<AuthorizedProviderRequest> = {},
): AuthorizedProviderRequest {
  return {
    binding: credential,
    requestId: `provider_req_${credential.audience}_0001`,
    attemptId: `att_${credential.audience}_0000000000000001`,
    providerId: credential.audience,
    modelId: "fixture-model",
    route: ROUTES[credential.audience],
    canonicalBody: canonicalJsonBytes({ model: "fixture-model", stream: true }, BROKER_LIMITS.maxRequestBodyBytes),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function fixedHandle(audience: CredentialAudience = "openai"): CredentialBindingLease {
  const broker = new TestCanaryCredentialBroker();
  return broker.issueCredential(audience, `fixed-lease-canary-${audience}-00000001`);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("amended credential broker boundary", () => {
  it.each([
    ["openai", "openai_responses", "https://api.openai.com", "/v1/responses"],
    ["anthropic", "anthropic_messages", "https://api.anthropic.com", "/v1/messages"],
    ["openrouter", "openrouter_responses", "https://openrouter.ai", "/api/v1/responses"],
  ] as const)("maps %s and its route to one compiled HTTPS POST", async (
    audience,
    route,
    origin,
    path,
  ) => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential(audience, CANARY);
    broker.enqueue({ audience, route, chunks: [{ bytes: "event: fixture\ndata: {}\n\n" }] });
    const request = descriptor(handle);
    const response = await broker.exchange(request);
    await collect(response.body);

    expect(broker.observations()).toEqual([{
      requestId: request.requestId,
      attemptId: request.attemptId,
      providerId: request.providerId,
      modelId: request.modelId,
      audience,
      route,
      origin,
      path,
      method: "POST",
      bodyBytes: request.canonicalBody.byteLength,
      bodyBytesWritten: request.canonicalBody.byteLength,
      generatedHeaderBytes: expect.any(Number),
      redirect: "error",
      automaticRetries: 0,
      ambientProxy: "disabled",
      credentialAttached: true,
    }]);
    expect(BROKER_DESTINATIONS[route]).toMatchObject({ audience, origin, path, method: "POST" });
  });

  it("accepts only the eight exact descriptor fields and immutable opaque handle grammar", () => {
    const good = descriptor(fixedHandle());
    expect(authorizeProviderRequest(good)).toMatchObject({
      audience: "openai",
      route: "openai_responses",
      origin: "https://api.openai.com",
      path: "/v1/responses",
      method: "POST",
      redirect: "error",
      automaticRetries: 0,
      ambientProxy: "disabled",
    });
    for (const value of [
      { ...good, authorization: "Bearer attacker" },
      { ...good, headers: { host: "evil.invalid" } },
      { ...good, url: "https://evil.invalid" },
      { ...good, path: "/v1/messages" },
      { ...good, method: "GET" },
      { ...good, proxy: "http://127.0.0.1:8080" },
      { ...good, retryCount: 9 },
      { ...good, binding: { ...good.binding, token: "secret" } },
      { ...good, binding: { ...good.binding, bindingId: "short" } },
    ]) {
      expect(() => authorizeProviderRequest(value)).toThrowError(
        expect.objectContaining({ reasonCode: "invalid_descriptor" }),
      );
    }
  });

  it.each(([
    "Authorization",
    "Proxy-Authorization",
    "x-api-key",
    "Host",
    ":authority",
    "Forwarded",
    "X-Forwarded-Host",
    "Connection",
    "Transfer-Encoding",
    "Content-Length",
    "Cookie",
    "Proxy",
  ] as const).flatMap((name) => [
    name,
    name.toLowerCase(),
    name.toUpperCase(),
    `${name} `,
    ` ${name}`,
    `${name}\r\nX-Smuggled`,
  ]))("makes attempted header smuggling impossible through descriptor field %s", (field) => {
    const value = { ...descriptor(fixedHandle()), [field]: "attacker" };
    expect(() => authorizeProviderRequest(value)).toThrowError(
      expect.objectContaining({ reasonCode: "invalid_descriptor" }),
    );
    expect(() => authorizeProviderRequest({
      ...descriptor(fixedHandle()),
      headers: [
        { name: field, value: "one" },
        { name: field, value: "two" },
      ],
    })).toThrowError(expect.objectContaining({ reasonCode: "invalid_descriptor" }));
  });

  it.each([
    "https://api.openai.com/v1/responses",
    "//api.openai.com/v1/responses",
    "\\\\api.openai.com\\v1\\responses",
    "/v1/../v1/responses",
    "/v1/%72esponses",
    "https://user:pass@api.openai.com/v1/responses",
    "/v1/responses#fragment",
    "/v1/responses?query=1",
    "http://api.openai.com/v1/responses",
  ])("rejects every input-derived destination variant %s", (destination) => {
    expect(() => authorizeProviderRequest({
      ...descriptor(fixedHandle()),
      destination,
    })).toThrowError(expect.objectContaining({ reasonCode: "invalid_descriptor" }));
  });

  it("rejects audience/route mismatch, noncanonical JSON bytes, duplicate keys, BOM, and fake signals", () => {
    const base = descriptor(fixedHandle());
    const fakeSignal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const invalid: unknown[] = [
      { ...base, audience: "anthropic" },
      { ...base, route: "anthropic_messages" },
      { ...base, canonicalBody: new TextEncoder().encode("{ \"stream\": true }") },
      { ...base, canonicalBody: new TextEncoder().encode("{\"a\":1,\"a\":2}") },
      { ...base, canonicalBody: new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]) },
      { ...base, signal: fakeSignal },
    ];
    for (const item of invalid) {
      expect(() => authorizeProviderRequest(item)).toThrowError(
        expect.objectContaining({ reasonCode: "invalid_descriptor" }),
      );
    }
  });

  it("captures one authentic signal value and ignores shadowed signal properties", async () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", { get: () => false });
    Object.defineProperty(controller.signal, "addEventListener", { value: () => undefined });
    controller.abort("hostile abort reason");
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    const error = await broker.exchange(descriptor(handle, { signal: controller.signal })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ reasonCode: "request_cancelled" });
    expect(JSON.stringify(error)).not.toContain("hostile abort reason");
    expect(broker.diagnostics()).toMatchObject({
      transportAttemptCount: 0,
      transportCloseCount: 0,
      credentialAttachmentCount: 0,
    });
    expect(broker.observations()).toHaveLength(0);
    expect(broker.bodySnapshots()).toHaveLength(0);
  });

  it("maps unknown, wrong-audience, and expired-like handles to the same stable zero-transport failure", async () => {
    const broker = new TestCanaryCredentialBroker();
    broker.issueCredential("openai", CANARY);
    const foreignBroker = new TestCanaryCredentialBroker();
    const unknown = foreignBroker.issueCredential("openai", "foreign-openai-canary-00000001");
    const wrongAudience = foreignBroker.issueCredential("anthropic", "foreign-anthropic-canary-000001");
    const expiredBroker = new TestCanaryCredentialBroker();
    const expired = expiredBroker.issueCredential("openai", CANARY);
    expiredBroker.expireCredential(expired);
    const errors = [];
    errors.push(await broker.exchange(descriptor(unknown)).catch((caught: unknown) => caught));
    errors.push(await broker.exchange(descriptor(wrongAudience)).catch((caught: unknown) => caught));
    errors.push(await expiredBroker.exchange(descriptor(expired)).catch((caught: unknown) => caught));
    expect(errors.map((error) => (error as CredentialBrokerError).reasonCode)).toEqual([
      "credential_unavailable",
      "credential_unavailable",
      "credential_unavailable",
    ]);
    expect(broker.diagnostics().transportAttemptCount).toBe(0);
  });

  it("allows exactly one outbound attempt for a descriptor and rejects request-ID replay", async () => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    broker.enqueue({ audience: "openai", route: "openai_responses" });
    const request = descriptor(handle);
    await broker.exchange(request);
    await expect(broker.exchange(request)).rejects.toMatchObject({
      reasonCode: "request_replayed",
      retryable: false,
    });
    expect(broker.diagnostics().transportAttemptCount).toBe(1);
  });

  it("classifies only the sealed numeric retryable statuses and every 3xx redirect", async () => {
    const exactRetryable = [408, 429, 500, 502, 503, 504, 524, 529] as const;
    expect(RETRYABLE_HTTP_STATUSES).toEqual(exactRetryable);
    expect(() => (RETRYABLE_HTTP_STATUSES as unknown as number[]).push(401)).toThrow();
    for (const status of exactRetryable) {
      const broker = new TestCanaryCredentialBroker();
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({ audience: "openai", route: "openai_responses", status });
      await expect(broker.exchange(descriptor(handle))).rejects.toMatchObject({
        reasonCode: "http_retryable_before_stream",
        retryable: true,
        statusClass: "http_retryable",
      });
    }
    for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 501, 505]) {
      const broker = new TestCanaryCredentialBroker();
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({ audience: "openai", route: "openai_responses", status });
      await expect(broker.exchange(descriptor(handle))).rejects.toMatchObject({
        reasonCode: "http_non_retryable",
        retryable: false,
      });
    }
    for (let status = 300; status < 400; status += 1) {
      const broker = new TestCanaryCredentialBroker();
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({ audience: "openai", route: "openai_responses", status });
      await expect(broker.exchange(descriptor(handle))).rejects.toMatchObject({
        reasonCode: "redirect_blocked",
        retryable: false,
      });
    }
  });

  it("requires explicit before-body proof for transport fallback and classifies every later ambiguity as unknown", async () => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      failure: "connect_failure_before_body",
    });
    await expect(broker.exchange(descriptor(handle))).rejects.toMatchObject({
      reasonCode: "connect_failure_before_body",
      retryable: true,
    });
    expect(broker.observations()[0]).toMatchObject({ bodyBytesWritten: 0 });
    expect(broker.bodySnapshots()).toHaveLength(0);

    const second = new TestCanaryCredentialBroker();
    const secondHandle = second.issueCredential("openai", CANARY);
    second.enqueue({
      audience: "openai",
      route: "openai_responses",
      failure: "outcome_unknown",
    });
    await expect(second.exchange(descriptor(secondHandle))).rejects.toMatchObject({
      reasonCode: "outcome_unknown",
      retryable: false,
    });
  });

  it.each([
    [[{ name: "content-type", value: "application/json" }]],
    [[{ name: "content-type", value: "text/event-stream" }, { name: "Content-Type", value: "text/event-stream" }]],
    [[{ name: "content-type", value: "text/event-stream" }, { name: "content-encoding", value: "gzip" }]],
    [[{ name: "content-type", value: "text/event-stream" }, { name: "transfer-encoding", value: "chunked" }]],
    [[{ name: "content-type", value: "text/event-stream\r\nx: y" }]],
  ])("rejects unreviewed, duplicate, compressed, framing, or smuggled response headers", async (responseHeaders) => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    broker.enqueue({ audience: "openai", route: "openai_responses", responseHeaders });
    await expect(broker.exchange(descriptor(handle))).rejects.toMatchObject({
      reasonCode: "invalid_response_headers",
      retryable: false,
    });
  });

  it("accepts only the exact SSE media type with at most normalized UTF-8 and identity encoding", async () => {
    for (const responseHeaders of [
      [{ name: "content-type", value: "text/event-stream" }],
      [{ name: "Content-Type", value: "Text/Event-Stream; Charset=UTF-8" }],
      [
        { name: "content-type", value: "text/event-stream" },
        { name: "content-encoding", value: "identity" },
      ],
    ]) {
      const broker = new TestCanaryCredentialBroker();
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({ audience: "openai", route: "openai_responses", responseHeaders });
      await expect(broker.exchange(descriptor(handle))).resolves.toMatchObject({ audience: "openai" });
    }
  });

  it("enforces N-1/N/N+1 broker-generated and response-header byte bounds", async () => {
    const baseline = new TestCanaryCredentialBroker();
    const baselineHandle = baseline.issueCredential("openai", CANARY);
    baseline.enqueue({ audience: "openai", route: "openai_responses" });
    await baseline.exchange(descriptor(baselineHandle));
    const requestHeaderN = baseline.observations()[0].generatedHeaderBytes;
    for (const delta of [-1, 0, 1] as const) {
      const broker = new TestCanaryCredentialBroker({
        maxRequestHeaderBytes: requestHeaderN + delta,
        maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
        maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
        maxDurationMs: BROKER_LIMITS.maxStreamDurationMs,
        maxIdleMs: BROKER_LIMITS.maxIdleMs,
      });
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({ audience: "openai", route: "openai_responses" });
      const operation = broker.exchange(descriptor(handle));
      if (delta < 0) await expect(operation).rejects.toMatchObject({ reasonCode: "request_headers_too_large" });
      else await expect(operation).resolves.toBeTruthy();
    }

    const responseHeaderN = new TextEncoder().encode("content-type:text/event-stream\r\n").byteLength;
    for (const delta of [-1, 0, 1] as const) {
      const broker = new TestCanaryCredentialBroker({
        maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
        maxResponseHeaderBytes: responseHeaderN + delta,
        maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
        maxDurationMs: BROKER_LIMITS.maxStreamDurationMs,
        maxIdleMs: BROKER_LIMITS.maxIdleMs,
      });
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({ audience: "openai", route: "openai_responses" });
      const operation = broker.exchange(descriptor(handle));
      if (delta < 0) await expect(operation).rejects.toMatchObject({ reasonCode: "invalid_response_headers" });
      else await expect(operation).resolves.toBeTruthy();
    }
  });

  it("enforces N-1/N/N+1 broker raw-stream byte bounds", async () => {
    const n = 64;
    for (const size of [n - 1, n, n + 1]) {
      const broker = new TestCanaryCredentialBroker({
        maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
        maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
        maxResponseBytes: n,
        maxDurationMs: BROKER_LIMITS.maxStreamDurationMs,
        maxIdleMs: BROKER_LIMITS.maxIdleMs,
      });
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: "x".repeat(size) }],
      });
      const response = await broker.exchange(descriptor(handle));
      const operation = collect(response.body);
      if (size <= n) await expect(operation).resolves.toHaveLength(size);
      else await expect(operation).rejects.toMatchObject({ reasonCode: "response_too_large" });
    }
  });

  it("blocks a credential reflected in an outbound body before any transport attempt", async () => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    const error = await broker.exchange(descriptor(handle, {
      canonicalBody: canonicalJsonBytes({ input: CANARY }, BROKER_LIMITS.maxRequestBodyBytes),
    })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reasonCode: "secret_reflection_blocked" });
    expect(JSON.stringify(error)).not.toContain(CANARY);
    expect(broker.diagnostics().transportAttemptCount).toBe(0);
  });

  it("quarantines every cross-chunk split of a reflected raw credential", async () => {
    const encoded = new TextEncoder().encode(CANARY);
    for (let split = 1; split < encoded.byteLength; split += 1) {
      const broker = new TestCanaryCredentialBroker();
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [
          { bytes: encoded.slice(0, split) },
          { bytes: encoded.slice(split) },
        ],
      });
      const response = await broker.exchange(descriptor(handle));
      const iterator = response.body[Symbol.asyncIterator]();
      const error = await iterator.next().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reasonCode: "secret_reflection_blocked" });
      expect(JSON.stringify(error)).not.toContain(CANARY);
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      expect(broker.diagnostics().transportCloseCount).toBe(1);
    }
  });

  it("scans decoded JSON escapes and adjacent normalized values before the secret suffix can escape", async () => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    broker.enqueue({ audience: "openai", route: "openai_responses" });
    const response = await broker.exchange(descriptor(handle));
    const encodedJson = JSON.stringify({ delta: CANARY }).replace("bbb", "\\u0062\\u0062\\u0062");
    const decoded = parseStrictJson(encodedJson);
    expect(() => response.assertCredentialAbsent(decoded)).toThrowError(
      expect.objectContaining({ reasonCode: "secret_reflection_blocked" }),
    );

    const second = new TestCanaryCredentialBroker();
    const secondHandle = second.issueCredential("openai", CANARY);
    second.enqueue({ audience: "openai", route: "openai_responses" });
    const secondResponse = await second.exchange(descriptor(secondHandle));
    const split = Math.floor(CANARY.length / 2);
    expect(() => secondResponse.assertCredentialAbsent({
      kind: "text_delta",
      requestId: "one",
      delta: CANARY.slice(0, split),
    })).not.toThrow();
    expect(() => secondResponse.assertCredentialAbsent({
      kind: "text_delta",
      requestId: "two",
      delta: CANARY.slice(split),
    })).toThrowError(
      expect.objectContaining({ reasonCode: "secret_reflection_blocked" }),
    );
  });

  it("does not expose reveal/enumerate/export APIs and can scan binary, toJSON, errors, and serialized surfaces", async () => {
    const broker = new TestCanaryCredentialBroker();
    const handle = broker.issueCredential("openai", CANARY);
    broker.enqueue({ audience: "openai", route: "openai_responses" });
    const response = await broker.exchange(descriptor(handle));
    const observables = {
      handle,
      observations: broker.observations(),
      diagnostics: broker.diagnostics(),
      serializedBroker: JSON.stringify(broker),
      surface: Reflect.ownKeys(broker),
    };
    expect(() => broker.assertCanaryAbsent(observables)).not.toThrow();
    expect(() => broker.assertCanaryAbsent(new TextEncoder().encode(CANARY))).toThrow(/canary/i);
    expect(() => broker.assertCanaryAbsent({ toJSON: () => "safe", hidden: CANARY })).toThrow(/canary/i);
    expect("reveal" in broker).toBe(false);
    expect("getSecret" in broker).toBe(false);
    expect("listCredentials" in broker).toBe(false);
    expect("exportCredentials" in broker).toBe(false);
    expect(response).not.toHaveProperty("headers");
  });

  it("redacts getter/proxy exceptions and never trusts forged exported broker-error instances", () => {
    const base = descriptor(fixedHandle()) as unknown as Record<string, unknown>;
    const forged = new CredentialBrokerError({
      reasonCode: "connect_failure_before_body",
      retryable: true,
      audience: "openai",
      requestId: "provider_req_openai_0001",
      statusClass: "transport_before_body",
    });
    expect(forged).not.toHaveProperty("attemptId");
    expect(forged).not.toHaveProperty("providerId");
    expect(forged).not.toHaveProperty("modelId");
    expect(JSON.stringify(forged)).not.toMatch(/attemptId|providerId|modelId/);
    const proxy = new Proxy(base, {
      ownKeys: () => {
        (forged as unknown as { message: string }).message = CANARY;
        throw forged;
      },
    });
    const error = (() => {
      try {
        authorizeProviderRequest(proxy);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ reasonCode: "invalid_descriptor", retryable: false });
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });

  it("enforces broker-level idle and total deadlines even when the body is consumed directly", async () => {
    for (const mode of ["idle", "total"] as const) {
      const broker = new TestCanaryCredentialBroker({
        maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
        maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
        maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
        maxDurationMs: mode === "total" ? 10 : 20,
        maxIdleMs: mode === "idle" ? 10 : 20,
      });
      const handle = broker.issueCredential("openai", CANARY);
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: "data: [DONE]\n\n", delayMs: 30 }],
      });
      const response = await broker.exchange(descriptor(handle));
      const started = Date.now();
      const error = await response.body[Symbol.asyncIterator]().next().catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        reasonCode: mode === "idle" ? "idle_timeout" : "duration_exceeded",
        retryable: false,
      });
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it("includes response-header acquisition in broker deadlines and closes exactly once", async () => {
    const broker = new TestCanaryCredentialBroker({
      maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
      maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
      maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
      maxDurationMs: 20,
      maxIdleMs: 5,
    });
    const binding = broker.issueCredential("openai", CANARY);
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      headerDelayMs: 50,
    });
    const started = Date.now();
    await expect(broker.exchange(descriptor(binding))).rejects.toMatchObject({
      reasonCode: "idle_timeout",
      retryable: false,
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(broker.diagnostics()).toMatchObject({
      transportAttemptCount: 1,
      transportCloseCount: 1,
    });
  });

  it("retains the attached attempt secret for quarantine after binding expiry during headers", async () => {
    const broker = new TestCanaryCredentialBroker();
    const binding = broker.issueCredential("openai", CANARY);
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      headerDelayMs: 30,
      chunks: [{ bytes: CANARY }],
    });
    const exchange = broker.exchange(descriptor(binding));
    setTimeout(() => broker.expireCredential(binding), 5);
    const response = await exchange;
    const iterator = response.body[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ reasonCode: "secret_reflection_blocked" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(() => broker.assertCanaryAbsent(response)).not.toThrow();
  });

  it("rotates binding revision atomically and makes a stale secret/revision pair unrepresentable", () => {
    const broker = new TestCanaryCredentialBroker();
    const original = broker.issueCredential("openai", CANARY);
    const rotated = broker.rotateCredential(original, "rotated-binding-secret-00000001");
    expect(rotated.revision).not.toBe(original.revision);
    expect(rotated.bindingId).not.toBe(original.bindingId);
    expect(broker.bindingIsCurrent(original)).toBe(false);
    expect(broker.bindingIsCurrent(rotated)).toBe(true);
    expect(() => authorizeProviderRequest(descriptor(original))).not.toThrow();
    expect(() => authorizeProviderRequest({
      ...descriptor(rotated),
      binding: Object.freeze({ ...rotated, revision: original.revision }),
    })).toThrowError(expect.objectContaining({ reasonCode: "invalid_descriptor" }));
  });

  it("validates every broker numeric configuration field at N-1/N/N+1 and rejects unsafe numbers", () => {
    const maxima = {
      maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
      maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
      maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
      maxDurationMs: BROKER_LIMITS.maxStreamDurationMs,
      maxIdleMs: BROKER_LIMITS.maxIdleMs,
    };
    for (const [key, maximum] of Object.entries(maxima)) {
      expect(() => new TestCanaryCredentialBroker({
        ...maxima,
        [key]: maximum - 1,
      })).not.toThrow();
      expect(() => new TestCanaryCredentialBroker({
        ...maxima,
        [key]: maximum,
      })).not.toThrow();
      expect(() => new TestCanaryCredentialBroker({
        ...maxima,
        [key]: maximum + 1,
      })).toThrow();
      for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => new TestCanaryCredentialBroker({
          ...maxima,
          [key]: invalid,
        })).toThrow();
      }
    }
  });

  it("rejects zero-byte broker chunks without treating them as idle progress", async () => {
    const broker = new TestCanaryCredentialBroker({
      maxRequestHeaderBytes: BROKER_LIMITS.maxRequestHeaderBytes,
      maxResponseHeaderBytes: BROKER_LIMITS.maxResponseHeaderBytes,
      maxResponseBytes: BROKER_LIMITS.maxResponseBytes,
      maxDurationMs: 30,
      maxIdleMs: 5,
    });
    const handle = broker.issueCredential("openai", CANARY);
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: new Uint8Array() }],
    });
    const response = await broker.exchange(descriptor(handle));
    await expect(response.body[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      reasonCode: "invalid_response",
    });
  });

  it("rejects N+1 canonical body bytes while accepting the exact N hard maximum", async () => {
    const base = descriptor(fixedHandle());
    const overhead = new TextEncoder().encode('{"x":""}').byteLength;
    const exact = canonicalJsonBytes({
      x: "a".repeat(BROKER_LIMITS.maxRequestBodyBytes - overhead),
    }, BROKER_LIMITS.maxRequestBodyBytes);
    const below = canonicalJsonBytes({
      x: "a".repeat(BROKER_LIMITS.maxRequestBodyBytes - overhead - 1),
    }, BROKER_LIMITS.maxRequestBodyBytes);
    expect(below.byteLength).toBe(BROKER_LIMITS.maxRequestBodyBytes - 1);
    expect(authorizeProviderRequest({ ...base, canonicalBody: below }).canonicalBody).toHaveLength(
      BROKER_LIMITS.maxRequestBodyBytes - 1,
    );
    expect(exact.byteLength).toBe(BROKER_LIMITS.maxRequestBodyBytes);
    expect(authorizeProviderRequest({ ...base, canonicalBody: exact }).canonicalBody).toHaveLength(
      BROKER_LIMITS.maxRequestBodyBytes,
    );
    const tooLarge = new Uint8Array(BROKER_LIMITS.maxRequestBodyBytes + 1);
    await expect(Promise.resolve().then(() => authorizeProviderRequest({ ...base, canonicalBody: tooLarge })))
      .rejects.toMatchObject({ reasonCode: "request_too_large" });
  });
});
