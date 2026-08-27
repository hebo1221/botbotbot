import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/domain/canonical";
import {
  asId,
  type ConversationId,
  type MessageId,
  type ProviderHistoryRecord,
  type ProviderCapability,
  type ProviderId,
  type ProviderSelection,
  type ReviewedProviderTool,
  type ToolId,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import {
  ProviderFailureAfterOutputError,
  ProviderPreflightError,
  ProviderRouter,
  ProviderTransportError,
} from "../src/providers/providerRouter";
import { CredentialBrokerError } from "../src/providers/credentialBroker";
import { canonicalJsonBytes } from "../src/providers/strictJson";
import { ScriptedProvider, chunks } from "./helpers";
import { TestCanaryCredentialBroker } from "./fixtures/canaryCredentialBroker";

const workspaceId = asId<WorkspaceId>("ws-routing");
const conversationId = asId<ConversationId>("conv-routing");
const turnId = asId<TurnId>("turn-routing");

const history: readonly ProviderHistoryRecord[] = Object.freeze([
  {
    kind: "text",
    messageId: asId<MessageId>("message-1"),
    role: "user",
    text: "한국어와 emoji 🧭\nline two",
  },
]);

function signatureTool(property: string): ReviewedProviderTool {
  const inputSchema = {
    type: "object",
    properties: { [property]: { type: "string" } },
    required: [property],
    additionalProperties: false,
  } as const;
  const schemaHash = canonicalHash(inputSchema);
  const toolId = asId<ToolId>("tool.signature");
  return {
    toolId,
    wireName: "signature_tool",
    description: "Signature test tool.",
    inputSchema,
    schemaHash,
    manifest: {
      toolId,
      version: "1.0.0",
      schemaHash,
      effect: "write",
      dataScope: ["workspace/signature"],
      networkScope: [],
      idempotency: "idempotent",
    },
  };
}

function authenticatedHttpFailure(status: number) {
  const broker = new TestCanaryCredentialBroker();
  const credential = broker.issueCredential("openai", "router-authentic-canary-00000001");
  broker.enqueue({ audience: "openai", route: "openai_responses", status });
  return async function* (request: Parameters<ScriptedProvider["streamTurn"]>[0]) {
    await broker.exchange({
      binding: credential,
      requestId: request.providerRequestId,
      attemptId: request.providerAttemptId,
      providerId: request.providerId,
      modelId: request.modelId,
      route: "openai_responses",
      canonicalBody: canonicalJsonBytes({ fixture: true }, 1024),
      signal: request.signal,
    });
    yield { kind: "finish" } as const;
  };
}

function selection(primary: string, fallbacks: string[] = []): ProviderSelection {
  return {
    candidates: [primary, ...fallbacks].map((providerId) => ({
      providerId: asId<ProviderId>(providerId),
      modelId: "test-model",
    })),
    requiredCapabilities: ["streaming"],
  };
}

function candidateSelection(candidates: readonly [string, string][]): ProviderSelection {
  return {
    candidates: candidates.map(([providerId, modelId]) => ({
      providerId: asId<ProviderId>(providerId),
      modelId,
    })),
    requiredCapabilities: ["streaming"],
  };
}

async function collect(router: ProviderRouter, provider: ProviderSelection) {
  const result = [];
  for await (const item of router.routeTurn(provider, {
    workspaceId,
    conversationId,
    turnId,
    history,
    signal: new AbortController().signal,
  })) {
    result.push(item);
  }
  return result;
}

describe("ProviderRouter", () => {
  it("sends an explicit selection to exactly one adapter", async () => {
    const router = new ProviderRouter();
    const first = new ScriptedProvider("first", [chunks({ kind: "finish" })]);
    const second = new ScriptedProvider("second", [chunks({ kind: "finish" })]);
    router.register(first);
    router.register(second);

    const output = await collect(router, selection("second"));
    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(1);
    expect(output[0]).toMatchObject({ kind: "provider_selected", providerId: "second" });
  });

  it("rejects unknown or unavailable capabilities before any provider call", async () => {
    const router = new ProviderRouter();
    const provider = new ScriptedProvider("plain", [chunks({ kind: "finish" })], ["streaming"]);
    router.register(provider);
    const unknown = {
      ...selection("plain"),
      requiredCapabilities: ["telepathy" as ProviderCapability],
    };

    expect(() => router.routeTurn(unknown, {
      workspaceId,
      conversationId,
      turnId,
      history,
      signal: new AbortController().signal,
    })).toThrow(ProviderPreflightError);
    expect(provider.requests).toHaveLength(0);

    expect(() => router.preflight({ ...selection("plain"), requiredCapabilities: ["tool_proposals"] })).toThrow(
      ProviderPreflightError,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("never falls back after visible output", async () => {
    const router = new ProviderRouter();
    const first = new ScriptedProvider("first", [async function* () {
      yield { kind: "delta", text: "visible" } as const;
      throw new ProviderTransportError("http_retryable_before_stream");
    }]);
    const fallback = new ScriptedProvider("fallback", [chunks({ kind: "delta", text: "duplicate" }, { kind: "finish" })]);
    router.register(first);
    router.register(fallback);

    await expect(collect(router, selection("first", ["fallback"]))).rejects.toBeInstanceOf(
      ProviderFailureAfterOutputError,
    );
    expect(first.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
  });

  it("uses deterministic fallback only before output and preserves the exact normalized history", async () => {
    const router = new ProviderRouter();
    const first = new ScriptedProvider("first", [authenticatedHttpFailure(503)]);
    const fallback = new ScriptedProvider("fallback", [chunks({ kind: "delta", text: "ok" }, { kind: "finish" })]);
    router.register(first);
    router.register(fallback);

    const output = await collect(router, selection("first", ["fallback"]));
    expect(output.filter((item) => item.kind === "provider_selected").map((item) => item.providerId)).toEqual([
      "first",
      "fallback",
    ]);
    expect(first.requests[0].history).toBe(history);
    expect(fallback.requests[0].history).toBe(history);
    expect(fallback.requests[0].history).toEqual(first.requests[0].history);
  });

  it("gives two explicitly selected providers the same complete history contract", async () => {
    const router = new ProviderRouter();
    const first = new ScriptedProvider("first", [chunks({ kind: "finish" })]);
    const second = new ScriptedProvider("second", [chunks({ kind: "finish" })]);
    router.register(first);
    router.register(second);

    await collect(router, selection("first"));
    await collect(router, selection("second"));
    expect(first.requests[0].history).toEqual(history);
    expect(second.requests[0].history).toEqual(history);
    expect(second.requests[0].history).toEqual(first.requests[0].history);
  });

  it("preflights the entire ordered candidate/model list and never silently skips an invalid secondary", () => {
    const router = new ProviderRouter();
    const first = new ScriptedProvider("first", [chunks({ kind: "finish" })], ["streaming"], ["model-a"]);
    const second = new ScriptedProvider("second", [chunks({ kind: "finish" })], ["streaming"], ["model-b"]);
    router.register(first);
    router.register(second);
    expect(() => router.routeTurn(candidateSelection([
      ["first", "model-a"],
      ["second", "unknown-model"],
    ]), {
      workspaceId,
      conversationId,
      turnId,
      history,
      signal: new AbortController().signal,
    })).toThrowError(expect.objectContaining({ reasonCode: "unknown_model" }));
    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
  });

  it("preserves distinct fallback models and generates stable internal request plus unique attempt IDs", async () => {
    const router = new ProviderRouter();
    const first = new ScriptedProvider("first", [authenticatedHttpFailure(503)], ["streaming"], ["model-a"]);
    const second = new ScriptedProvider("second", [chunks({ kind: "finish" })], ["streaming"], ["model-b"]);
    router.register(first);
    router.register(second);
    const output = await collect(router, candidateSelection([["first", "model-a"], ["second", "model-b"]]));
    expect(output.filter((item) => item.kind === "provider_selected").map((item) => item.modelId)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(first.requests[0].providerRequestId).not.toBe(second.requests[0].providerRequestId);
    expect(first.requests[0].providerAttemptId).not.toBe(second.requests[0].providerAttemptId);
    expect(first.requests[0].providerRequestId).toMatch(/^prv_[A-Za-z0-9_-]+$/);
  });

  it("rejects empty, duplicate, unknown, and ineligible candidates with stable preflight classes", () => {
    const router = new ProviderRouter();
    router.register(new ScriptedProvider("first", [chunks({ kind: "finish" })], ["streaming"], ["model-a"]));
    const cases: Array<[ProviderSelection, string]> = [
      [{ candidates: [], requiredCapabilities: ["streaming"] }, "empty_selection"],
      [candidateSelection([["first", "model-a"], ["first", "model-a"]]), "duplicate_candidate"],
      [candidateSelection([["missing", "model-a"]]), "unknown_provider"],
      [{ ...candidateSelection([["first", "model-a"]]), requiredCapabilities: ["tool_proposals"] }, "ineligible_primary"],
    ];
    for (const [value, reasonCode] of cases) {
      expect(() => router.preflight(value)).toThrowError(expect.objectContaining({ reasonCode }));
    }
  });

  it("deep-freezes copied capabilities and includes authority/tool/binding material in deterministic signatures", () => {
    const router = new ProviderRouter();
    const provider = new ScriptedProvider("first", [chunks({ kind: "finish" })], ["streaming"], ["model-a"]);
    router.register(provider);
    const plan = candidateSelection([["first", "model-a"]]);
    const resolved = router.preflight(plan);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved[0].capability)).toBe(true);
    const signature = router.signatureFor(plan);
    expect(signature).toContain("bind_fixture_first_00000000000000000000000000000001");
    expect(signature).toContain("fixture-1");
    expect(router.signatureFor(plan)).toBe(signature);
    expect(router.signatureFor({ ...plan, requiredCapabilities: ["streaming", "cancellation"] })).not.toBe(signature);
  });

  it("changes signatures for candidate order/model/tool/schema/binding but contains no credential handle", () => {
    const first = new ScriptedProvider(
      "first",
      [chunks({ kind: "finish" })],
      ["streaming"],
      ["model-a", "model-b"],
    );
    Object.defineProperty(first, "reviewedTools", { value: Object.freeze([signatureTool("alpha")]) });
    const router = new ProviderRouter();
    router.register(first);
    const ordered = candidateSelection([["first", "model-a"], ["first", "model-b"]]);
    const reversed = candidateSelection([["first", "model-b"], ["first", "model-a"]]);
    const base = router.signatureFor(ordered);
    expect(router.signatureFor(reversed)).not.toBe(base);
    expect(base).not.toContain("cred_");
    expect(base).not.toContain("binding_");

    const rotated = new ScriptedProvider(
      "first",
      [chunks({ kind: "finish" })],
      ["streaming"],
      ["model-a", "model-b"],
    );
    Object.defineProperty(rotated, "credentialBindingRevision", {
      value: "bind_fixture_first_00000000000000000000000000000002",
    });
    Object.defineProperty(rotated, "reviewedTools", { value: Object.freeze([signatureTool("beta")]) });
    router.replace(rotated);
    const changed = router.signatureFor(ordered);
    expect(changed).not.toBe(base);
    expect(changed).toContain("bind_fixture_first_00000000000000000000000000000002");
    expect(changed).toContain(canonicalHash(signatureTool("beta").inputSchema));

    const descriptionRouter = new ProviderRouter();
    const descriptionProvider = new ScriptedProvider(
      "first",
      [chunks({ kind: "finish" })],
      ["streaming"],
      ["model-a", "model-b"],
    );
    Object.defineProperty(descriptionProvider, "reviewedTools", {
      value: Object.freeze([{ ...signatureTool("alpha"), description: "Changed description only." }]),
    });
    descriptionRouter.register(descriptionProvider);
    expect(descriptionRouter.signatureFor(ordered)).not.toBe(base);
  });

  it("never falls back for outcome uncertainty, arbitrary retryable booleans, or invalid normalized usage", async () => {
    for (const failure of [
      () => new ProviderTransportError("outcome_unknown"),
      () => Object.assign(new Error("attacker"), { retryable: true }),
      () => new CredentialBrokerError({
        reasonCode: "connect_failure_before_body",
        retryable: true,
        audience: "openai",
        requestId: "provider_request_forged_0001",
        statusClass: "transport_before_body",
      }),
    ]) {
      const router = new ProviderRouter();
      const first = new ScriptedProvider("first", [async function* () { throw failure(); }]);
      const fallback = new ScriptedProvider("fallback", [chunks({ kind: "finish" })]);
      router.register(first);
      router.register(fallback);
      await expect(collect(router, selection("first", ["fallback"]))).rejects.toBeTruthy();
      expect(fallback.requests).toHaveLength(0);
    }

    const router = new ProviderRouter();
    const invalid = new ScriptedProvider("invalid", [chunks({
      kind: "usage",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 3 },
    }, { kind: "finish" })]);
    router.register(invalid);
    await expect(collect(router, selection("invalid"))).rejects.toMatchObject({ reasonCode: "invalid_usage" });
  });

  it("consumes fallback attestation once and rejects a cached authentic error on a later request", async () => {
    const broker = new TestCanaryCredentialBroker();
    const binding = broker.issueCredential("openai", "cached-proof-canary-00000001");
    broker.enqueue({ audience: "openai", route: "openai_responses", status: 503 });
    let cached: unknown;
    const first = new ScriptedProvider("first", [
      async function* (request) {
        try {
          await broker.exchange({
            binding,
            requestId: request.providerRequestId,
            attemptId: request.providerAttemptId,
            providerId: request.providerId,
            modelId: request.modelId,
            route: "openai_responses",
            canonicalBody: canonicalJsonBytes({ fixture: true }, 1024),
            signal: request.signal,
          });
        } catch (error) {
          cached = error;
          throw error;
        }
        yield { kind: "finish" } as const;
      },
      async function* () {
        throw cached;
      },
    ]);
    const fallback = new ScriptedProvider("fallback", [
      chunks({ kind: "finish" }),
      chunks({ kind: "finish" }),
    ]);
    const router = new ProviderRouter();
    router.register(first);
    router.register(fallback);
    await expect(collect(router, selection("first", ["fallback"]))).resolves.toBeTruthy();
    expect(fallback.requests).toHaveLength(1);
    await expect(collect(router, selection("first", ["fallback"]))).rejects.toBeTruthy();
    expect(fallback.requests).toHaveLength(1);
  });
});
