import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/domain/canonical";
import {
  asId,
  type Actor,
  type ConversationId,
  type ProviderAdapter,
  type ProviderId,
  type ProviderSelection,
  type ReviewedProviderTool,
  type ToolId,
  type ToolManifest,
  type WorkspaceId,
} from "../src/domain/contracts";
import { ToolPolicy } from "../src/policy/toolPolicy";
import {
  AnthropicMessagesAdapter,
  ANTHROPIC_MESSAGES_PROTOCOL_REVISION,
} from "../src/providers/anthropicMessagesAdapter";
import {
  OpenAIResponsesAdapter,
  OPENAI_RESPONSES_PROTOCOL_REVISION,
} from "../src/providers/openAIResponsesAdapter";
import {
  OpenRouterResponsesAdapter,
  OPENROUTER_RESPONSES_PROTOCOL_REVISION,
} from "../src/providers/openRouterResponsesAdapter";
import {
  ProviderPreflightError,
  ProviderRouter,
  ProviderTransportError,
} from "../src/providers/providerRouter";
import { ProviderHistoryValidationError } from "../src/providers/providerHistory";
import { ProviderStreamBoundaryError } from "../src/providers/providerStream";
import { ReviewedToolError } from "../src/providers/reviewedTools";
import {
  CredentialBrokerError,
  PrivilegedCredentialBroker,
  type AuthorizedProviderRequest,
  type AuthorizedBrokerDestination,
  type BrokerAttemptMonitor,
  type BrokerStreamResponse,
  type CredentialBindingLease,
  type CredentialBroker,
  type PrivilegedBrokerExchangeResult,
} from "../src/providers/credentialBroker";
import { projectConversation } from "../src/runtime/conversationProjection";
import { RuntimeCoordinator } from "../src/runtime/runtimeCoordinator";
import { DurableJournal } from "../src/storage/durableJournal";
import { UniversalToolGateway } from "../src/tools/universalToolGateway";
import { ScriptedProvider, TempArea, zeroCostAccounting } from "./helpers";
import {
  FaultingCanaryCredentialBroker,
  TestCanaryCredentialBroker,
} from "./fixtures/canaryCredentialBroker";
import {
  anthropicTextStream,
  anthropicToolStream,
  responsesTextStream,
  responsesToolStream,
} from "./fixtures/providerStreams";

const temporary = new TempArea();
afterEach(() => temporary.cleanup());

const CANARY = "runtime-provider-canary-0f7613da";
const workspaceId = asId<WorkspaceId>("workspace_provider_runtime");
const conversationId = asId<ConversationId>("conversation_provider_runtime");
const human: Actor = { kind: "human", id: "human-owner" };
const agent: Actor = { kind: "agent", id: "agent-provider" };
const budget = { maxSteps: 100, maxCostUnits: 0, maxDurationMs: 10_000 };
const policyContext = { grantedDataScopes: [] as string[], grantedNetworkScopes: [] as string[] };

class ThrowingPrivilegedBroker extends PrivilegedCredentialBroker {
  issue(): CredentialBindingLease {
    return this.issueBindingLease("openai");
  }

  protected exchangeAuthorized(
    _destination: AuthorizedBrokerDestination,
    _monitor: BrokerAttemptMonitor,
  ): Promise<PrivilegedBrokerExchangeResult> {
    const error = new Error("PRIVILEGED_RAW_ERROR_CANARY_001");
    error.name = "PRIVILEGED_RAW_NAME_CANARY_002";
    (error as Error & { cause?: unknown }).cause = "PRIVILEGED_RAW_CAUSE_CANARY_003";
    throw error;
  }
}

class ThrowingAdapterBoundaryBroker extends ThrowingPrivilegedBroker {
  override async exchange(_request: AuthorizedProviderRequest): Promise<BrokerStreamResponse> {
    const error = new Error("PLAIN_RAW_ERROR_CANARY_001");
    error.name = "PLAIN_RAW_NAME_CANARY_002";
    (error as Error & { cause?: unknown }).cause = "PLAIN_RAW_CAUSE_CANARY_003";
    throw error;
  }
}

const MODELS = Object.freeze({
  openai: "gpt-5.4-2026-08-01",
  anthropic: "claude-sonnet-4-5-20250929",
  openrouter: "openai/gpt-5.4",
});

function selection(provider: keyof typeof MODELS): ProviderSelection {
  return {
    candidates: [{ providerId: asId<ProviderId>(provider), modelId: MODELS[provider] }],
    requiredCapabilities: ["streaming", "usage", "cancellation"],
  };
}

function tool(effect: "write" | "pure_compute" | "external_read" = "write"): ReviewedProviderTool {
  const inputSchema = {
    type: "object",
    properties: { text: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["text"],
    additionalProperties: false,
  } as const;
  const schemaHash = canonicalHash(inputSchema);
  const manifest: ToolManifest = {
    toolId: asId<ToolId>("tool.write-note"),
    version: "1.0.0",
    schemaHash,
    effect,
    dataScope: effect === "external_read" ? ["workspace/notes"] : effect === "write" ? ["workspace/notes"] : [],
    networkScope: [],
    idempotency: "non_idempotent",
    ...(effect === "pure_compute" ? { allowPureComputation: true } : {}),
  };
  return {
    toolId: manifest.toolId,
    wireName: "write_note",
    description: "Write one reviewed note.",
    inputSchema,
    schemaHash,
    manifest,
  };
}

function adapter(provider: keyof typeof MODELS, broker: TestCanaryCredentialBroker, tools: readonly ReviewedProviderTool[] = []) {
  const credential = broker.issueCredential(provider, CANARY);
  const protocolRevision = provider === "openai"
    ? OPENAI_RESPONSES_PROTOCOL_REVISION
    : provider === "anthropic"
      ? ANTHROPIC_MESSAGES_PROTOCOL_REVISION
      : OPENROUTER_RESPONSES_PROTOCOL_REVISION;
  const options = {
    broker,
    binding: credential,
    capabilities: [{
      providerId: asId<ProviderId>(provider),
      modelId: MODELS[provider],
      protocolRevision,
      streaming: true,
      toolProposals: true,
      imageInput: false,
      usage: true,
      cancellation: true,
      opaqueReasoningRoundTrip: false,
    }],
    reviewedTools: tools,
  };
  return provider === "openai" ? new OpenAIResponsesAdapter(options) :
    provider === "anthropic" ? new AnthropicMessagesAdapter(options) :
      new OpenRouterResponsesAdapter(options);
}

async function harness(adapters: ProviderAdapter[], register?: (gateway: UniversalToolGateway) => void) {
  const directory = await temporary.directory();
  const journal = await DurableJournal.open(`${directory}/provider-runtime.journal`);
  const router = new ProviderRouter();
  adapters.forEach((item) => router.register(item));
  const gateway = new UniversalToolGateway(new ToolPolicy("provider-policy-v1"), journal);
  register?.(gateway);
  const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
  await coordinator.createWorkspace(workspaceId, "Provider workspace", human);
  await coordinator.createConversation(workspaceId, conversationId, "Provider conversation", human);
  return { journal, router, gateway, coordinator };
}

describe("public provider runtime integration", () => {
  it.each(([
    "openai",
    "anthropic",
    "openrouter",
  ] as const).flatMap((provider) => ([
    "assertCredentialAbsent",
    "quarantineDecoded",
  ] as const).map((target) => ({ provider, target }))))(
    "$provider $target forged broker-response errors never cross router/runtime observables",
    async ({ provider, target }) => {
      const broker = new FaultingCanaryCredentialBroker(target, () => {
        const error = new CredentialBrokerError({
          reasonCode: "secret_reflection_blocked",
          retryable: false,
          audience: provider,
          requestId: "prv_runtime_response_fault_00000001",
          statusClass: "request_rejected",
        });
        Object.defineProperties(error, {
          name: { configurable: true, value: `RUNTIME_RESPONSE_NAME_${CANARY}` },
          message: { configurable: true, value: `RUNTIME_RESPONSE_MESSAGE_${CANARY}` },
          cause: { configurable: true, value: `RUNTIME_RESPONSE_CAUSE_${CANARY}` },
          stack: { configurable: true, value: `RUNTIME_RESPONSE_STACK_${CANARY}` },
        });
        return error;
      });
      const current = adapter(provider, broker);
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: provider === "anthropic"
          ? anthropicTextStream({ model: MODELS[provider] })
          : responsesTextStream({ model: MODELS[provider], profile: provider }) }],
      });
      const logs: unknown[] = [];
      const spies = ["log", "warn", "error"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation((...items: unknown[]) => { logs.push(items); })
      );
      const { journal, coordinator } = await harness([current]);
      try {
        const result = await coordinator.sendMessage({
          workspaceId,
          conversationId,
          clientRequestId: `response-boundary-${provider}-${target}`,
          content: "exercise hostile broker response boundary",
          user: human,
          proposingAgent: agent,
          provider: selection(provider),
          budget,
          policyContext,
        });
        expect(result).toMatchObject({
          status: "failed",
          reasonCode: target === "assertCredentialAbsent"
            ? "secret_reflection_blocked"
            : "protocol_violation",
        });
        const observable = JSON.stringify({
          result,
          journal: journal.snapshot(),
          renderer: projectConversation(journal.snapshot(), conversationId),
          logs,
          diagnostics: { broker: broker.diagnostics(), runtime: coordinator.cacheSizes() },
        });
        expect(observable).not.toContain(CANARY);
        expect(() => broker.assertCanaryAbsent(observable)).not.toThrow();
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        await journal.close();
      }
    },
  );

  it.each(["plain", "privileged"] as const)(
    "redacts %s raw broker errors through adapter, turn result, journal, renderer, logs, and diagnostics",
    async (kind) => {
      const canaries = [
        "PLAIN_RAW_ERROR_CANARY_001",
        "PLAIN_RAW_NAME_CANARY_002",
        "PLAIN_RAW_CAUSE_CANARY_003",
        "PRIVILEGED_RAW_ERROR_CANARY_001",
        "PRIVILEGED_RAW_NAME_CANARY_002",
        "PRIVILEGED_RAW_CAUSE_CANARY_003",
      ];
      let binding: CredentialBindingLease;
      let broker: CredentialBroker;
      if (kind === "privileged") {
        const privileged = new ThrowingPrivilegedBroker();
        binding = privileged.issue();
        broker = privileged;
      } else {
        const adapterBoundary = new ThrowingAdapterBoundaryBroker();
        binding = adapterBoundary.issue();
        broker = adapterBoundary;
      }
      const current = new OpenAIResponsesAdapter({
        broker,
        binding,
        capabilities: [{
          providerId: asId<ProviderId>("openai"),
          modelId: MODELS.openai,
          protocolRevision: OPENAI_RESPONSES_PROTOCOL_REVISION,
          streaming: true,
          toolProposals: true,
          imageInput: false,
          usage: true,
          cancellation: true,
          opaqueReasoningRoundTrip: false,
        }],
      });
      const logs: unknown[] = [];
      const spies = ["log", "warn", "error"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation((...items: unknown[]) => { logs.push(items); })
      );
      const { journal, coordinator } = await harness([current]);
      try {
        const result = await coordinator.sendMessage({
          workspaceId,
          conversationId,
          clientRequestId: `raw-broker-${kind}`,
          content: "exercise raw broker error",
          user: human,
          proposingAgent: agent,
          provider: selection("openai"),
          budget,
          policyContext,
        });
        expect(result).toMatchObject({
          status: "failed",
          reasonCode: kind === "privileged" ? "outcome_unknown" : "provider_error",
        });
        const observable = JSON.stringify({
          result,
          journal: journal.snapshot(),
          renderer: projectConversation(journal.snapshot(), conversationId),
          logs,
          cacheDiagnostics: coordinator.cacheSizes(),
        });
        for (const canary of canaries) expect(observable).not.toContain(canary);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        await journal.close();
      }
    },
  );

  it.each([
    ProviderPreflightError,
    ProviderTransportError,
    ProviderStreamBoundaryError,
    ProviderHistoryValidationError,
    ReviewedToolError,
  ] as const)(
    "quarantines a forged %s across router, result, journal, renderer, logs, and diagnostics",
    async (ErrorClass) => {
      const forged = Object.create(ErrorClass.prototype) as Error & {
        reasonCode: string;
        cause: string;
      };
      Object.defineProperties(forged, {
        name: { value: "FORGED_CLASS_NAME_CANARY_001", enumerable: true },
        message: { value: "FORGED_CLASS_MESSAGE_CANARY_002", enumerable: true },
        reasonCode: { value: "FORGED_CLASS_REASON_CANARY_003", enumerable: true },
        cause: { value: "FORGED_CLASS_CAUSE_CANARY_004", enumerable: true },
      });
      const current = new ScriptedProvider(
        "openai",
        [async function* () { throw forged; }],
        ["streaming", "usage", "cancellation"],
        [MODELS.openai],
      );
      const logs: unknown[] = [];
      const spies = ["log", "warn", "error"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation((...items: unknown[]) => { logs.push(items); })
      );
      const { journal, coordinator } = await harness([current]);
      try {
        const result = await coordinator.sendMessage({
          workspaceId,
          conversationId,
          clientRequestId: `forged-error-${ErrorClass.name}`,
          content: "exercise a forged exported error",
          user: human,
          proposingAgent: agent,
          provider: selection("openai"),
          budget,
          policyContext,
        });
        expect(result).toMatchObject({ status: "failed", reasonCode: "outcome_unknown" });
        const observable = JSON.stringify({
          result,
          journal: journal.snapshot(),
          renderer: projectConversation(journal.snapshot(), conversationId),
          logs,
          cacheDiagnostics: coordinator.cacheSizes(),
        });
        for (const canary of [
          "FORGED_CLASS_NAME_CANARY_001",
          "FORGED_CLASS_MESSAGE_CANARY_002",
          "FORGED_CLASS_REASON_CANARY_003",
          "FORGED_CLASS_CAUSE_CANARY_004",
        ]) expect(observable).not.toContain(canary);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        await journal.close();
      }
    },
  );

  it.each(["openai", "anthropic", "openrouter"] as const)(
    "%s completes a durable text-only turn with enriched non-secret selection evidence",
    async (provider) => {
      const broker = new TestCanaryCredentialBroker();
      const current = adapter(provider, broker);
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: provider === "anthropic"
          ? anthropicTextStream({ model: MODELS[provider] })
          : responsesTextStream({ model: MODELS[provider], profile: provider }) }],
      });
      const { journal, coordinator } = await harness([current]);
      const result = await coordinator.sendMessage({
        workspaceId,
        conversationId,
        clientRequestId: `runtime-${provider}`,
        content: "hello provider",
        user: human,
        proposingAgent: agent,
        provider: selection(provider),
        budget,
        policyContext,
      });
      expect(result).toMatchObject({ status: "completed", assistantText: "hello world", costUnits: 0 });
      const selected = journal.snapshot().find((event) => event.type === "provider.selected");
      expect(selected?.payload).toMatchObject({
        providerId: provider,
        modelId: MODELS[provider],
        protocolRevision: current.capabilities[0].protocolRevision,
        credentialBindingRevision: expect.stringMatching(/^bind_/),
        providerRequestId: expect.stringMatching(/^prv_/),
        fallbackIndex: 0,
      });
      expect(JSON.stringify(journal.snapshot())).not.toContain(CANARY);
      expect(JSON.stringify(journal.snapshot())).not.toContain("cred_");
      expect(JSON.stringify(journal.snapshot())).not.toContain("binding_");
      expect(() => broker.assertCanaryAbsent({
        result,
        journal: journal.snapshot(),
        renderer: projectConversation(journal.snapshot(), conversationId),
        diagnostics: broker.diagnostics(),
      })).not.toThrow();
      await journal.close();
    },
  );

  it.each(([
    "openai",
    "anthropic",
    "openrouter",
  ] as const).flatMap((provider) => (["pure_compute", "external_read"] as const).map(
    (effect) => ({ provider, effect }),
  )))(
    "$provider provider proposal with auto-allow $effect still requires an exact fixture grant",
    async ({ provider, effect }) => {
      const reviewed = tool(effect);
      const broker = new TestCanaryCredentialBroker();
      const current = adapter(provider, broker, [reviewed]);
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: provider === "anthropic"
          ? anthropicToolStream({ model: MODELS[provider] })
          : responsesToolStream({ model: MODELS[provider], profile: provider }) }],
      });
      const effects: string[] = [];
      const { journal, coordinator } = await harness([current], (gateway) => gateway.registerTool({
        manifest: reviewed.manifest,
        execute: async ({ idempotencyKey }) => {
          effects.push(idempotencyKey);
          return { output: { ok: true }, outputSummary: "Auto-allow fixture executed after grant." };
        },
      }));
      const scopedPolicyContext = effect === "external_read"
        ? { grantedDataScopes: ["workspace/notes"], grantedNetworkScopes: [] as string[] }
        : policyContext;
      const clientRequestId = `exact-grant-${provider}-${effect}`;
      const paused = await coordinator.sendMessage({
        workspaceId,
        conversationId,
        clientRequestId,
        content: "propose an auto-allow effect",
        user: human,
        proposingAgent: agent,
        provider: { ...selection(provider), requiredCapabilities: ["streaming", "tool_proposals", "usage"] },
        budget,
        policyContext: scopedPolicyContext,
      });
      expect(paused).toMatchObject({
        status: "paused",
        decision: { outcome: "ask", reasonCode: "provider_proposal_requires_exact_grant" },
      });
      expect(effects).toHaveLength(0);
      expect(journal.snapshot().some((event) => event.type === "tool.execution.started")).toBe(false);
      if (paused.status !== "paused") throw new Error("Expected provider pause");
      const result = await coordinator.decideProposal({
        workspaceId,
        conversationId,
        clientRequestId,
        turnId: paused.turnId,
        proposalId: paused.proposal.proposalId,
        disposition: "approve",
        approver: { principalId: "human-owner", kind: "human", assurance: "authenticated_control_plane" },
        provider: { ...selection(provider), requiredCapabilities: ["streaming", "tool_proposals", "usage"] },
        budget,
        policyContext: scopedPolicyContext,
      });
      expect(effects).toHaveLength(1);
      expect(result).toMatchObject({ status: "failed", reasonCode: "incomplete_durable_tool_history" });
      await journal.close();
    },
  );

  it("switches exact providers/models across one complete durable text-only history", async () => {
    const openAIBroker = new TestCanaryCredentialBroker();
    const anthropicBroker = new TestCanaryCredentialBroker();
    const openAI = adapter("openai", openAIBroker);
    const anthropic = adapter("anthropic", anthropicBroker);
    openAIBroker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openai, profile: "openai", first: "first ", second: "answer" }) }],
    });
    anthropicBroker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      chunks: [{ bytes: anthropicTextStream({ model: MODELS.anthropic, text: "second answer" }) }],
    });
    const { journal, coordinator } = await harness([openAI, anthropic]);
    await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "switch-openai", content: "first question",
      user: human, proposingAgent: agent, provider: selection("openai"), budget, policyContext,
    });
    await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "switch-anthropic", content: "second question",
      user: human, proposingAgent: agent, provider: selection("anthropic"), budget, policyContext,
    });
    expect((anthropicBroker.bodySnapshots()[0] as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: "second question" }] },
    ]);
    expect(projectConversation(journal.snapshot(), conversationId).normalizedHistory.map((item) => item.content)).toEqual([
      "first question", "first answer", "second question", "second answer",
    ]);
    await journal.close();
  });

  it("falls back across exact provider/model candidates only for a sealed pre-SSE retryable status", async () => {
    const openAIBroker = new TestCanaryCredentialBroker();
    const anthropicBroker = new TestCanaryCredentialBroker();
    const openAI = adapter("openai", openAIBroker);
    const anthropic = adapter("anthropic", anthropicBroker);
    openAIBroker.enqueue({
      audience: "openai",
      route: "openai_responses",
      status: 429,
    });
    anthropicBroker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      chunks: [{ bytes: anthropicTextStream({ model: MODELS.anthropic, text: "fallback answer" }) }],
    });
    const { journal, coordinator } = await harness([openAI, anthropic]);
    const result = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "sealed-fallback",
      content: "route transparently",
      user: human,
      proposingAgent: agent,
      provider: {
        candidates: [
          { providerId: asId<ProviderId>("openai"), modelId: MODELS.openai },
          { providerId: asId<ProviderId>("anthropic"), modelId: MODELS.anthropic },
        ],
        requiredCapabilities: ["streaming", "usage"],
      },
      budget,
      policyContext,
    });
    expect(result).toMatchObject({ status: "completed", assistantText: "fallback answer" });
    expect(journal.snapshot().filter((event) => event.type === "provider.selected").map(
      (event) => (event.payload as { providerId: string; modelId: string; fallbackIndex: number }),
    )).toMatchObject([
      { providerId: "openai", modelId: MODELS.openai, fallbackIndex: 0 },
      { providerId: "anthropic", modelId: MODELS.anthropic, fallbackIndex: 1 },
    ]);
    expect(openAIBroker.diagnostics().transportAttemptCount).toBe(1);
    expect(anthropicBroker.diagnostics().transportAttemptCount).toBe(1);
    await journal.close();
  });

  it("falls back on an authenticated zero-body connect proof and records zero request bytes written", async () => {
    const openAIBroker = new TestCanaryCredentialBroker();
    const anthropicBroker = new TestCanaryCredentialBroker();
    const openAI = adapter("openai", openAIBroker);
    const anthropic = adapter("anthropic", anthropicBroker);
    openAIBroker.enqueue({
      audience: "openai",
      route: "openai_responses",
      failure: "connect_failure_before_body",
    });
    anthropicBroker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      chunks: [{ bytes: anthropicTextStream({ model: MODELS.anthropic, text: "connected fallback" }) }],
    });
    const { journal, coordinator } = await harness([openAI, anthropic]);
    const result = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "connect-proof-fallback",
      content: "connect safely",
      user: human,
      proposingAgent: agent,
      provider: {
        candidates: [
          { providerId: asId<ProviderId>("openai"), modelId: MODELS.openai },
          { providerId: asId<ProviderId>("anthropic"), modelId: MODELS.anthropic },
        ],
        requiredCapabilities: ["streaming", "usage"],
      },
      budget,
      policyContext,
    });
    expect(result).toMatchObject({ status: "completed", assistantText: "connected fallback" });
    expect(openAIBroker.observations()[0]).toMatchObject({ bodyBytesWritten: 0 });
    expect(openAIBroker.bodySnapshots()).toHaveLength(0);
    await journal.close();
  });

  it("supports same-broker same-provider different-model fallback with unique request and attempt IDs", async () => {
    const broker = new TestCanaryCredentialBroker();
    const binding = broker.issueCredential("openai", CANARY);
    const alternateModel = "gpt-5.4-2026-08-15";
    const current = new OpenAIResponsesAdapter({
      broker,
      binding,
      capabilities: [MODELS.openai, alternateModel].map((modelId) => ({
        providerId: asId<ProviderId>("openai"),
        modelId,
        protocolRevision: OPENAI_RESPONSES_PROTOCOL_REVISION,
        streaming: true,
        toolProposals: true,
        imageInput: false,
        usage: true,
        cancellation: true,
        opaqueReasoningRoundTrip: false,
      })),
    });
    broker.enqueue({ audience: "openai", route: "openai_responses", status: 503 });
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({ model: alternateModel, profile: "openai" }) }],
    });
    const { journal, coordinator } = await harness([current]);
    const result = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "same-broker-model-fallback",
      content: "try exact alternate model",
      user: human,
      proposingAgent: agent,
      provider: {
        candidates: [
          { providerId: asId<ProviderId>("openai"), modelId: MODELS.openai },
          { providerId: asId<ProviderId>("openai"), modelId: alternateModel },
        ],
        requiredCapabilities: ["streaming", "usage"],
      },
      budget,
      policyContext,
    });
    expect(result).toMatchObject({ status: "completed", assistantText: "hello world" });
    const observations = broker.observations();
    expect(observations).toHaveLength(2);
    expect(observations[0].requestId).not.toBe(observations[1].requestId);
    expect(observations[0].attemptId).not.toBe(observations[1].attemptId);
    expect(observations.map((item) => item.modelId)).toEqual([MODELS.openai, alternateModel]);
    await journal.close();
  });

  it("abort during fallback transition produces one cancelled outcome and no late fallback output", async () => {
    const openAIBroker = new TestCanaryCredentialBroker();
    const anthropicBroker = new TestCanaryCredentialBroker();
    const openAI = adapter("openai", openAIBroker);
    const anthropic = adapter("anthropic", anthropicBroker);
    openAIBroker.enqueue({ audience: "openai", route: "openai_responses", status: 503 });
    anthropicBroker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      headerDelayMs: 2_000,
      chunks: [{ bytes: anthropicTextStream({ model: MODELS.anthropic, text: "must stay late" }) }],
    });
    const { journal, coordinator } = await harness([openAI, anthropic]);
    const controller = new AbortController();
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "abort-fallback-transition",
      content: "cancel fallback",
      user: human,
      proposingAgent: agent,
      provider: {
        candidates: [
          { providerId: asId<ProviderId>("openai"), modelId: MODELS.openai },
          { providerId: asId<ProviderId>("anthropic"), modelId: MODELS.anthropic },
        ],
        requiredCapabilities: ["streaming", "usage"],
      },
      budget,
      policyContext,
      signal: controller.signal,
    });
    for (let index = 0; index < 100 && anthropicBroker.diagnostics().transportAttemptCount === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(anthropicBroker.diagnostics().transportAttemptCount).toBe(1);
    controller.abort("secret fallback abort detail");
    await expect(send).resolves.toMatchObject({ status: "cancelled" });
    expect(projectConversation(journal.snapshot(), conversationId).normalizedHistory.map((item) => item.content))
      .toEqual(["cancel fallback"]);
    expect(JSON.stringify(journal.snapshot())).not.toContain("must stay late");
    expect(JSON.stringify(journal.snapshot())).not.toContain("secret fallback abort detail");
    expect(anthropicBroker.diagnostics().transportCloseCount).toBe(1);
    await journal.close();
  });

  it("rejects idempotent replay after credential binding revision rotation without dispatching under new authority", async () => {
    const firstBroker = new TestCanaryCredentialBroker();
    const first = adapter("openai", firstBroker);
    firstBroker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openai, profile: "openai" }) }],
    });
    const { journal, router, coordinator } = await harness([first]);
    const input = {
      workspaceId,
      conversationId,
      clientRequestId: "binding-rotation",
      content: "same logical request",
      user: human,
      proposingAgent: agent,
      provider: selection("openai"),
      budget,
      policyContext,
    };
    await expect(coordinator.sendMessage(input)).resolves.toMatchObject({ status: "completed" });

    const attemptsBeforeRotation = firstBroker.diagnostics().transportAttemptCount;
    const rotatedCredential = firstBroker.rotateCurrentCredential("openai", "rotated-provider-canary-125bb3a1");
    const rotated = new OpenAIResponsesAdapter({
      broker: firstBroker,
      binding: rotatedCredential,
      capabilities: first.capabilities,
    });
    router.replace(rotated);
    await expect(coordinator.sendMessage(input)).rejects.toMatchObject({
      reasonCode: "client_request_conflict",
    });
    expect(firstBroker.diagnostics().transportAttemptCount).toBe(attemptsBeforeRotation);
    await journal.close();
  });

  it("holds a signed provider plan across journal awaits and rejects binding rotation before dispatch", async () => {
    const firstBroker = new TestCanaryCredentialBroker();
    const first = adapter("openai", firstBroker);
    firstBroker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openai, profile: "openai" }) }],
    });
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const directory = await temporary.directory();
    const journal = await DurableJournal.open(`${directory}/binding-race.journal`, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "provider.selected")) {
            reached();
            await releasePromise;
          }
        },
      },
    });
    const router = new ProviderRouter();
    router.register(first);
    const gateway = new UniversalToolGateway(new ToolPolicy("binding-race-policy"), journal);
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Binding race", human);
    await coordinator.createConversation(workspaceId, conversationId, "Binding race", human);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "binding-toctou",
      content: "signed old authority",
      user: human,
      proposingAgent: agent,
      provider: selection("openai"),
      budget,
      policyContext,
    });
    await reachedPromise;
    const rotatedCredential = firstBroker.rotateCurrentCredential("openai", "rotated-race-canary-c03fbb78");
    router.replace(new OpenAIResponsesAdapter({
      broker: firstBroker,
      binding: rotatedCredential,
      capabilities: first.capabilities,
    }));
    release();
    await expect(send).resolves.toMatchObject({ status: "failed", reasonCode: "authority_changed" });
    expect(firstBroker.diagnostics().transportAttemptCount).toBe(0);
    expect(journal.snapshot().filter((event) => event.type === "provider.selected")).toHaveLength(1);
    await journal.close();
  });

  it.each(["openai", "anthropic", "openrouter"] as const)(
    "%s proposal pauses only at the universal gateway with zero external effect before fixture grant",
    async (provider) => {
      const reviewed = tool();
      const broker = new TestCanaryCredentialBroker();
      const current = adapter(provider, broker, [reviewed]);
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: provider === "anthropic"
          ? anthropicToolStream({ model: MODELS[provider] })
          : responsesToolStream({ model: MODELS[provider], profile: provider }) }],
      });
      const effects: string[] = [];
      const { journal, coordinator } = await harness([current], (gateway) => gateway.registerTool({
        manifest: reviewed.manifest,
        execute: async ({ idempotencyKey }) => {
          effects.push(idempotencyKey);
          return { output: { ok: true }, outputSummary: "Tool fixture completed." };
        },
      }));
      const paused = await coordinator.sendMessage({
        workspaceId, conversationId, clientRequestId: `tool-${provider}`, content: "write a note",
        user: human, proposingAgent: agent,
        provider: { ...selection(provider), requiredCapabilities: ["streaming", "tool_proposals", "usage"] },
        budget, policyContext,
      });
      expect(paused.status).toBe("paused");
      expect(effects).toHaveLength(0);
      expect(journal.snapshot().some((event) => event.type === "tool.execution.started")).toBe(false);
      if (paused.status !== "paused") throw new Error("Expected pause");

      const afterFixtureGrant = await coordinator.decideProposal({
        workspaceId,
        conversationId,
        clientRequestId: `tool-${provider}`,
        turnId: paused.turnId,
        proposalId: paused.proposal.proposalId,
        disposition: "approve",
        approver: {
          principalId: "human-owner",
          kind: "human",
          assurance: "authenticated_control_plane",
        },
        provider: { ...selection(provider), requiredCapabilities: ["streaming", "tool_proposals", "usage"] },
        budget,
        policyContext,
      });
      expect(effects).toHaveLength(1);
      expect(afterFixtureGrant).toMatchObject({ status: "failed", reasonCode: "incomplete_durable_tool_history" });
      expect(broker.diagnostics().transportAttemptCount).toBe(1);
      expect(JSON.stringify(journal.snapshot())).not.toContain(CANARY);
      await journal.close();
    },
  );

  it.each(["openai", "anthropic", "openrouter"] as const)(
    "%s binds signed reviewed-tool authority to the exact gateway registration",
    async (provider) => {
      const reviewed = tool();
      const broker = new TestCanaryCredentialBroker();
      const current = adapter(provider, broker, [reviewed]);
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: provider === "anthropic"
          ? anthropicToolStream({ model: MODELS[provider] })
          : responsesToolStream({ model: MODELS[provider], profile: provider }) }],
      });
      const effects: string[] = [];
      const mismatchedManifest: ToolManifest = {
        ...reviewed.manifest,
        version: "2.0.0-stale-registration",
      };
      const { journal, coordinator } = await harness([current], (gateway) => gateway.registerTool({
        manifest: mismatchedManifest,
        execute: async ({ idempotencyKey }) => {
          effects.push(idempotencyKey);
          return { output: { unsafe: true }, outputSummary: "must not execute" };
        },
      }));
      const result = await coordinator.sendMessage({
        workspaceId,
        conversationId,
        clientRequestId: `tool-authority-mismatch-${provider}`,
        content: "exercise stale gateway registration",
        user: human,
        proposingAgent: agent,
        provider: { ...selection(provider), requiredCapabilities: ["streaming", "tool_proposals", "usage"] },
        budget,
        policyContext,
      });
      expect(result).toMatchObject({ status: "failed", reasonCode: "proposal_forged" });
      expect(effects).toEqual([]);
      expect(journal.snapshot().filter((event) => event.type === "tool.proposed")).toEqual([]);
      await journal.close();
    },
  );
});
