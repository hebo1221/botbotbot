import { describe, expect, it, vi } from "vitest";
import {
  BoundedTextAccumulator,
  DEFAULT_PROVIDER_STREAM_LIMITS,
  ProviderStreamBoundaryError,
  parseBoundedToolArguments,
  parseEventJson,
  parseSseByteStream,
  validateProviderStreamLimits,
  validateProviderUsage,
  validateProviderWireId,
  type ProviderStreamLimits,
  type SseFrame,
} from "../src/providers/providerStream";

const requestId = "provider_request_00000001";
const audience = "openai" as const;
const ERROR_CANARY = "bbb-source-error-canary-75d781e3";

function bytes(...chunks: readonly (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  return async function* () {
    for (const chunk of chunks) {
      yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    }
  }();
}

function limits(overrides: Partial<ProviderStreamLimits>): ProviderStreamLimits {
  return { ...DEFAULT_PROVIDER_STREAM_LIMITS, ...overrides };
}

async function collect(
  source: AsyncIterable<Uint8Array>,
  selectedLimits: ProviderStreamLimits = DEFAULT_PROVIDER_STREAM_LIMITS,
  signal: AbortSignal = new AbortController().signal,
  customRequestId = requestId,
): Promise<readonly SseFrame[]> {
  const result: SseFrame[] = [];
  for await (const frame of parseSseByteStream(
    source,
    selectedLimits,
    signal,
    customRequestId,
    audience,
  )) result.push(frame);
  return result;
}

describe("amended bounded provider SSE transport", () => {
  it("preserves arbitrary chunks, split UTF-8, LF/CRLF, comments, and multiline data", async () => {
    const source = ": keepalive\r\n" +
      "\r\n" +
      "event: response.output_text.delta\r\n" +
      "data: {\"type\":\"response.output_text.delta\",\r\n" +
      "data: \"delta\":\"안녕🧭\"}\r\n\r\n" +
      "data: [DONE]\n\n";
    const encoded = new TextEncoder().encode(source);
    const frames = await collect(bytes(...[...encoded].map((value) => new Uint8Array([value]))));
    expect(frames).toEqual([
      { kind: "comment", rawBytes: 13 },
      {
        kind: "event",
        event: "response.output_text.delta",
        data: "{\"type\":\"response.output_text.delta\",\n\"delta\":\"안녕🧭\"}",
        rawBytes: expect.any(Number),
      },
      { kind: "event", data: "[DONE]", rawBytes: 14 },
    ]);
  });

  it.each([
    ["BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("data: [DONE]\n\n")])],
    ["NUL", "event: x\ndata: a\0b\n\n"],
    ["bare CR", "event: x\rdata: {}\n\n"],
    ["id field", "id: 1\nevent: x\ndata: {}\n\n"],
    ["retry field", "retry: 10\nevent: x\ndata: {}\n\n"],
    ["duplicate event", "event: x\nevent: x\ndata: {}\n\n"],
    ["unknown field", "authority: changed\nevent: x\ndata: {}\n\n"],
    ["event without data", "event: x\n\n"],
    ["event-less JSON", "data: {}\n\n"],
    ["unterminated record", "event: x\ndata: {}"],
  ])("fails closed on forbidden SSE grammar: %s", async (_label, source) => {
    await expect(collect(bytes(source))).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
  });

  it("rejects malformed UTF-8 without copying bytes or decoder details into the error", async () => {
    const error = await collect(bytes(new Uint8Array([0xff, 0xfe, 0x0a, 0x0a]))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ reasonCode: "malformed_utf8", requestId, audience });
    expect(JSON.stringify(error)).not.toContain("ff");
  });

  it("counts comments, known, ignored, ping, and DONE records before consumers classify them", async () => {
    const stream = bytes(
      ": c\n\n",
      "event: ping\ndata: {\"type\":\"ping\"}\n\n",
      "event: vendor.future\ndata: {\"type\":\"vendor.future\"}\n\n",
      "data: [DONE]\n\n",
    );
    await expect(collect(stream, limits({ maxEvents: 3 }))).rejects.toMatchObject({
      reasonCode: "too_many_events",
    });
  });

  it("enforces exact N-1/N/N+1 line, assembled-event, response, and event-count boundaries", async () => {
    const line = "event: x";
    const record = `${line}\ndata: {}\n\n`;
    const lineN = new TextEncoder().encode(line).byteLength;
    await expect(collect(bytes(record), limits({ maxLineBytes: lineN - 1 }))).rejects.toMatchObject({
      reasonCode: "event_line_too_large",
    });
    await expect(collect(bytes(record), limits({ maxLineBytes: lineN }))).resolves.toHaveLength(1);

    const eventN = new TextEncoder().encode(record).byteLength;
    await expect(collect(bytes(record), limits({ maxEventBytes: eventN - 1 }))).rejects.toMatchObject({
      reasonCode: "event_too_large",
    });
    await expect(collect(bytes(record), limits({ maxEventBytes: eventN }))).resolves.toHaveLength(1);

    const responseN = new TextEncoder().encode(record).byteLength;
    await expect(collect(bytes(record), limits({ maxResponseBytes: responseN - 1 }))).rejects.toMatchObject({
      reasonCode: "response_too_large",
    });
    await expect(collect(bytes(record), limits({ maxResponseBytes: responseN }))).resolves.toHaveLength(1);
    await expect(collect(bytes(record, record), limits({ maxEvents: 1 }))).rejects.toMatchObject({
      reasonCode: "too_many_events",
    });

    const behavioralLineN = 32;
    const lineRecord = (lineSize: number) =>
      `event: x\ndata: ${"a".repeat(lineSize - "data: ".length)}\n\n`;
    await expect(collect(bytes(lineRecord(behavioralLineN - 1)), limits({ maxLineBytes: behavioralLineN })))
      .resolves.toHaveLength(1);
    await expect(collect(bytes(lineRecord(behavioralLineN)), limits({ maxLineBytes: behavioralLineN })))
      .resolves.toHaveLength(1);
    await expect(collect(bytes(lineRecord(behavioralLineN + 1)), limits({ maxLineBytes: behavioralLineN })))
      .rejects.toMatchObject({ reasonCode: "event_line_too_large" });

    const eventRecords = [7, 8, 9].map((size) => `event: x\ndata: ${"a".repeat(size)}\n\n`);
    const assembledN = new TextEncoder().encode(eventRecords[1]).byteLength;
    await expect(collect(bytes(eventRecords[0]), limits({ maxEventBytes: assembledN }))).resolves.toHaveLength(1);
    await expect(collect(bytes(eventRecords[1]), limits({ maxEventBytes: assembledN }))).resolves.toHaveLength(1);
    await expect(collect(bytes(eventRecords[2]), limits({ maxEventBytes: assembledN }))).rejects.toMatchObject({
      reasonCode: "event_too_large",
    });

    const behavioralResponseN = new TextEncoder().encode(eventRecords[1]).byteLength;
    await expect(collect(bytes(eventRecords[0]), limits({ maxResponseBytes: behavioralResponseN }))).resolves.toHaveLength(1);
    await expect(collect(bytes(eventRecords[1]), limits({ maxResponseBytes: behavioralResponseN }))).resolves.toHaveLength(1);
    await expect(collect(bytes(eventRecords[2]), limits({ maxResponseBytes: behavioralResponseN }))).rejects.toMatchObject({
      reasonCode: "response_too_large",
    });

    const one = "event: x\ndata: {}\n\n";
    await expect(collect(bytes(one), limits({ maxEvents: 2 }))).resolves.toHaveLength(1);
    await expect(collect(bytes(one, one), limits({ maxEvents: 2 }))).resolves.toHaveLength(2);
    await expect(collect(bytes(one, one, one), limits({ maxEvents: 2 }))).rejects.toMatchObject({
      reasonCode: "too_many_events",
    });
  });

  it("rejects every unsafe numeric configuration and permits only lowering hard maxima", () => {
    const invalid: unknown[] = [
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: 0 },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: -1 },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: 1.5 },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: Number.NaN },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: Number.POSITIVE_INFINITY },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: Number.MAX_SAFE_INTEGER + 1 },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxEvents: DEFAULT_PROVIDER_STREAM_LIMITS.maxEvents + 1 },
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, disableBounds: true },
      null,
      [],
    ];
    for (const value of invalid) {
      expect(() => validateProviderStreamLimits(value)).toThrowError(
        expect.objectContaining({ reasonCode: "invalid_limits" }),
      );
    }
    expect(validateProviderStreamLimits(DEFAULT_PROVIDER_STREAM_LIMITS)).toEqual(
      DEFAULT_PROVIDER_STREAM_LIMITS,
    );
    for (const [key, maximum] of Object.entries(DEFAULT_PROVIDER_STREAM_LIMITS)) {
      expect(() => validateProviderStreamLimits({
        ...DEFAULT_PROVIDER_STREAM_LIMITS,
        [key]: Math.max(1, maximum - 1),
      })).not.toThrow();
      expect(() => validateProviderStreamLimits({
        ...DEFAULT_PROVIDER_STREAM_LIMITS,
        [key]: maximum,
      })).not.toThrow();
      expect(() => validateProviderStreamLimits({
        ...DEFAULT_PROVIDER_STREAM_LIMITS,
        [key]: maximum + 1,
      })).toThrowError(expect.objectContaining({ reasonCode: "invalid_limits" }));
    }
  });

  it("redacts source acquisition/next failures and forged exported boundary errors", async () => {
    const forged = new ProviderStreamBoundaryError(
      "duration_exceeded",
      requestId,
      audience,
    );
    (forged as unknown as { message: string }).message = ERROR_CANARY;
    const sources: AsyncIterable<Uint8Array>[] = [
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          throw forged;
        },
      },
      {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return { next: async () => { throw forged; } };
        },
      },
    ];
    for (const source of sources) {
      const error = await collect(source).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reasonCode: "upstream_stream_failure", retryable: false });
      expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
    }

    const issued = await collect(bytes("event: x\ndata: {}" )).catch((caught: unknown) => caught);
    const replaySource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return { next: async () => { throw issued; } };
      },
    };
    const replayed = await collect(replaySource).catch((caught: unknown) => caught);
    expect(replayed).toMatchObject({ reasonCode: "upstream_stream_failure" });

    const mapperSource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw new Error("trusted transport detail"); },
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    const mapperError = await (async () => {
      try {
        for await (const _frame of parseSseByteStream(
          mapperSource,
          DEFAULT_PROVIDER_STREAM_LIMITS,
          new AbortController().signal,
          requestId,
          audience,
          () => { throw new Error(ERROR_CANARY); },
        )) {
          // No frame is expected.
        }
      } catch (caught) {
        return caught;
      }
    })();
    expect(mapperError).toMatchObject({ reasonCode: "upstream_stream_failure" });
    expect(JSON.stringify(mapperError)).not.toContain(ERROR_CANARY);
  });

  it("rejects zero-length chunks as zero-progress input instead of resetting idle time", async () => {
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false as const, value: new Uint8Array() }),
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    await expect(collect(source, limits({ maxIdleMs: 5, maxDurationMs: 30 }))).rejects.toMatchObject({
      reasonCode: "upstream_stream_failure",
    });
  });

  it("uses intrinsic abort state/listeners, returns promptly, and suppresses hostile late bytes/reasons", async () => {
    let released = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>((resolve) => {
            setTimeout(() => {
              released = true;
              resolve({ done: false, value: new TextEncoder().encode("data: [DONE]\n\n") });
            }, 100);
          }),
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", { get: () => false });
    Object.defineProperty(controller.signal, "addEventListener", { value: () => undefined });
    const started = Date.now();
    const pending = collect(source, DEFAULT_PROVIDER_STREAM_LIMITS, controller.signal);
    setTimeout(() => controller.abort(ERROR_CANARY), 10);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reasonCode: "request_cancelled" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(released).toBe(true);
  });

  it("enforces idle and total monotonic deadlines, including before each buffered yield", async () => {
    const never = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    await expect(collect(never, limits({ maxIdleMs: 10, maxDurationMs: 20 }))).rejects.toMatchObject({
      reasonCode: "idle_timeout",
    });

    const iterator = parseSseByteStream(
      bytes("event: one\ndata: {}\n\nevent: two\ndata: {}\n\n"),
      limits({ maxIdleMs: 50, maxDurationMs: 20 }),
      new AbortController().signal,
      requestId,
      audience,
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "event", event: "one" } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(iterator.next()).rejects.toMatchObject({ reasonCode: "duration_exceeded" });
  });

  it.each(["idle", "duration"] as const)(
    "enforces deterministic N-1/N/N+1 %s elapsed-time behavior",
    async (boundaryKind) => {
      const n = 20;
      for (const delay of [n - 1, n, n + 1]) {
        vi.useFakeTimers();
        try {
          let emitted = false;
          const source: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
              return {
                next: () => {
                  if (emitted) return Promise.resolve({ done: true as const, value: undefined });
                  emitted = true;
                  return new Promise<IteratorResult<Uint8Array>>((resolve) => {
                    setTimeout(() => resolve({
                      done: false,
                      value: new TextEncoder().encode("data: [DONE]\n\n"),
                    }), delay);
                  });
                },
                return: async () => ({ done: true as const, value: undefined }),
              };
            },
          };
          const operation = collect(source, limits({
            maxDurationMs: boundaryKind === "duration" ? n : 100,
            maxIdleMs: boundaryKind === "idle" ? n : 100,
          }));
          const settled = operation.then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          await vi.advanceTimersByTimeAsync(delay + 2);
          const outcome = await settled;
          if (delay <= n) {
            expect(outcome).toMatchObject({ status: "fulfilled", value: [{ kind: "event" }] });
          } else {
            expect(outcome).toMatchObject({
              status: "rejected",
              error: { reasonCode: boundaryKind === "idle" ? "idle_timeout" : "duration_exceeded" },
            });
          }
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it("awaits cleanup exactly once on success, failure, abort, and timeout", async () => {
    for (const mode of ["success", "failure", "abort"] as const) {
      let closes = 0;
      const controller = new AbortController();
      let calls = 0;
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              calls += 1;
              if (mode === "abort") return await new Promise<IteratorResult<Uint8Array>>(() => undefined);
              if (mode === "failure") throw new Error(ERROR_CANARY);
              if (calls === 1) return { done: false, value: new TextEncoder().encode("data: [DONE]\n\n") };
              return { done: true, value: undefined };
            },
            return: async () => {
              closes += 1;
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { done: true as const, value: undefined };
            },
          };
        },
      };
      const pending = collect(source, limits({ maxIdleMs: 20, maxDurationMs: 40 }), controller.signal);
      if (mode === "abort") setTimeout(() => controller.abort(), 5);
      if (mode === "success") await expect(pending).resolves.toHaveLength(1);
      else await expect(pending).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
      expect(closes).toBe(1);
    }
  });

  it("turns cleanup rejection/hang into a stable bounded error without trusting cleanup details", async () => {
    for (const cleanup of ["reject", "hang"] as const) {
      let calls = 0;
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              calls += 1;
              return calls === 1
                ? { done: false, value: new TextEncoder().encode("data: [DONE]\n\n") }
                : { done: true, value: undefined };
            },
            return: async () => {
              if (cleanup === "reject") throw new Error(ERROR_CANARY);
              return await new Promise(() => undefined);
            },
          };
        },
      };
      const error = await collect(source, limits({ maxCleanupMs: 10 })).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reasonCode: "cleanup_failed", retryable: false });
      expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
    }
  });

  it("parses duplicate-aware/depth-bounded JSON and requires event/type equality", () => {
    const frame: SseFrame = {
      kind: "event",
      event: "response.created",
      data: "{\"type\":\"response.created\",\"nested\":{\"ok\":true}}",
      rawBytes: 80,
    };
    expect(parseEventJson(frame, DEFAULT_PROVIDER_STREAM_LIMITS, requestId, audience)).toMatchObject({
      type: "response.created",
    });
    for (const data of [
      "{\"type\":\"response.created\",\"type\":\"response.created\"}",
      "{\"type\":\"response.other\"}",
      "{\"type\":",
    ]) {
      expect(() => parseEventJson({ ...frame, data }, DEFAULT_PROVIDER_STREAM_LIMITS, requestId, audience))
        .toThrowError(ProviderStreamBoundaryError);
    }
    const depth = `${"[".repeat(65)}0${"]".repeat(65)}`;
    expect(() => parseEventJson({ ...frame, data: `{"type":"response.created","x":${depth}}` },
      DEFAULT_PROVIDER_STREAM_LIMITS, requestId, audience)).toThrowError(
      expect.objectContaining({ reasonCode: "json_depth_exceeded" }),
    );
    for (const [nestedArrays, succeeds] of [[62, true], [63, true], [64, false]] as const) {
      const nested = `${"[".repeat(nestedArrays)}0${"]".repeat(nestedArrays)}`;
      const operation = () => parseEventJson({
        ...frame,
        data: `{"type":"response.created","x":${nested}}`,
      }, DEFAULT_PROVIDER_STREAM_LIMITS, requestId, audience);
      if (succeeds) expect(operation).not.toThrow();
      else expect(operation).toThrowError(expect.objectContaining({ reasonCode: "json_depth_exceeded" }));
    }
  });

  it("enforces canonical object arguments at exact byte/depth bounds", () => {
    expect(parseBoundedToolArguments(
      "{\"city\":\"서울\",\"days\":2}",
      DEFAULT_PROVIDER_STREAM_LIMITS,
      requestId,
      audience,
    )).toEqual({ city: "서울", days: 2 });
    for (const value of ["[]", "null", "{\"x\":", "{\"x\":1,\"x\":2}"]) {
      expect(() => parseBoundedToolArguments(value, DEFAULT_PROVIDER_STREAM_LIMITS, requestId, audience))
        .toThrowError(ProviderStreamBoundaryError);
    }
    const exactLimits = limits({ maxToolArgumentBytes: 16 });
    const exact = "{\"x\":\"12345678\"}";
    const below = "{\"x\":\"1234567\"}";
    expect(new TextEncoder().encode(below)).toHaveLength(15);
    expect(() => parseBoundedToolArguments(below, exactLimits, requestId, audience)).not.toThrow();
    expect(new TextEncoder().encode(exact)).toHaveLength(16);
    expect(() => parseBoundedToolArguments(exact, exactLimits, requestId, audience)).not.toThrow();
    expect(() => parseBoundedToolArguments(`${exact} `, exactLimits, requestId, audience)).toThrowError(
      expect.objectContaining({ reasonCode: "tool_arguments_too_large" }),
    );
    const authorityChanging = {
      ...DEFAULT_PROVIDER_STREAM_LIMITS,
      maxToolArgumentBytes: Number.POSITIVE_INFINITY,
    } as ProviderStreamLimits;
    expect(() => parseBoundedToolArguments("{}", authorityChanging, requestId, audience)).toThrowError(
      expect.objectContaining({ reasonCode: "invalid_limits" }),
    );
  });

  it("bounds accumulated assistant text and provider IDs at N-1/N/N+1", () => {
    const accumulator = new BoundedTextAccumulator(4, requestId, audience);
    expect(accumulator.append("abc")).toBe("abc");
    expect(accumulator.append("d")).toBe("d");
    expect(accumulator.byteLength()).toBe(4);
    expect(() => accumulator.append("e")).toThrowError(
      expect.objectContaining({ reasonCode: "text_too_large" }),
    );

    const idLimits = limits({ maxIdBytes: 4 });
    expect(validateProviderWireId("abc", idLimits, requestId, audience)).toBe("abc");
    expect(validateProviderWireId("abcd", idLimits, requestId, audience)).toBe("abcd");
    expect(() => validateProviderWireId("abcde", idLimits, requestId, audience)).toThrowError(
      expect.objectContaining({ reasonCode: "invalid_provider_id" }),
    );
    const getterLimits = { ...DEFAULT_PROVIDER_STREAM_LIMITS } as ProviderStreamLimits;
    Object.defineProperty(getterLimits, "maxIdBytes", {
      enumerable: true,
      get: () => { throw new Error(ERROR_CANARY); },
    });
    const error = (() => {
      try {
        validateProviderWireId("abcd", getterLimits, requestId, audience);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ reasonCode: "invalid_limits" });
    expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
  });

  it("normalizes only finite non-negative safe-integer usage with an exact total", () => {
    expect(validateProviderUsage({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }, requestId, audience))
      .toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    for (const item of [
      { inputTokens: -1, outputTokens: 3, totalTokens: 2 },
      { inputTokens: 1.5, outputTokens: 3, totalTokens: 4.5 },
      { inputTokens: Number.NaN, outputTokens: 3, totalTokens: 3 },
      { inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      { inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 1 },
    ]) {
      expect(() => validateProviderUsage(item, requestId, audience)).toThrowError(
        expect.objectContaining({ reasonCode: "invalid_usage" }),
      );
    }
    const getterUsage = {} as Record<string, unknown>;
    Object.defineProperties(getterUsage, {
      inputTokens: { enumerable: true, get: () => { throw new Error(ERROR_CANARY); } },
      outputTokens: { enumerable: true, value: 1 },
      totalTokens: { enumerable: true, value: 1 },
    });
    const error = (() => {
      try {
        validateProviderUsage(getterUsage, requestId, audience);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ reasonCode: "invalid_usage" });
    expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
  });

  it("sanitizes invalid and secret-bearing internal request IDs", async () => {
    const secretId = `bad\n${ERROR_CANARY}`;
    const error = await collect(bytes("data: [DONE]\n\n"), DEFAULT_PROVIDER_STREAM_LIMITS,
      new AbortController().signal, secretId).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reasonCode: "invalid_request_id", requestId: "request-invalid" });
    expect(JSON.stringify(error)).not.toContain(ERROR_CANARY);
  });
});
