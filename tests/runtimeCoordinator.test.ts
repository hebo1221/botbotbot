import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash, type JsonValue } from "../src/domain/canonical";
import {
  asId,
  type ApprovalGrant,
  type Actor,
  type ConversationId,
  type DraftAuditEvent,
  type EventId,
  type MessageId,
  type ProviderId,
  type ProviderCapability,
  type ProviderChunk,
  type ProposalId,
  type PreparedToolProposal,
  type ProviderSelection,
  type ReviewedProviderTool,
  type AuditEventType,
  type ToolId,
  type ToolManifest,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import { ToolPolicy } from "../src/policy/toolPolicy";
import { ProviderRouter, ProviderTurnCancelledError } from "../src/providers/providerRouter";
import { projectConversation } from "../src/runtime/conversationProjection";
import {
  MAX_COORDINATOR_CACHE_ENTRIES,
  RuntimeCapacityError,
  RuntimeCommandValidationError,
  RuntimeCoordinator,
  StaleTurnControlError,
  setBoundedCacheEntry,
  setLiveStateEntry,
  type TurnResult,
  type ProposalDecisionInput,
  type SendMessageInput,
} from "../src/runtime/runtimeCoordinator";
import type { TrustedCostAccountingPort } from "../src/runtime/runtimeCoordinator";
import { DurableJournal } from "../src/storage/durableJournal";
import {
  ToolExecutionBlockedError,
  UniversalToolGateway,
  type ToolAuditPort,
} from "../src/tools/universalToolGateway";
import { MutableClock, ScriptedProvider, TempArea, chunks, zeroCostAccounting } from "./helpers";

const temporary = new TempArea();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await temporary.cleanup();
});

const workspaceId = asId<WorkspaceId>("ws-runtime");
const conversationId = asId<ConversationId>("conv-runtime");
const user: Actor = { kind: "human", id: "human-owner" };
const agent: Actor = { kind: "agent", id: "agent-yoonseul" };
const approver = {
  principalId: "human-owner",
  kind: "human" as const,
  assurance: "authenticated_control_plane" as const,
};
const policyContext = { grantedDataScopes: [] as string[], grantedNetworkScopes: [] as string[] };
const generousBudget = { maxSteps: 50, maxCostUnits: 100, maxDurationMs: 10_000 };

function reviewedFixtureTool(
  manifest: Omit<ToolManifest, "schemaHash">,
  inputSchema: JsonValue,
): ReviewedProviderTool {
  const schemaHash = canonicalHash(inputSchema);
  return Object.freeze({
    toolId: manifest.toolId,
    wireName: "fixture_tool",
    description: "Independently reviewed fixture tool.",
    inputSchema,
    schemaHash,
    manifest: Object.freeze({ ...manifest, schemaHash }),
  });
}

function providerSelection(
  providerId: string,
  requiredCapabilities: readonly ProviderCapability[] = ["streaming"],
): ProviderSelection {
  return {
    candidates: [{ providerId: asId<ProviderId>(providerId), modelId: "test-model" }],
    requiredCapabilities,
  };
}

async function harness(
  providers: readonly ScriptedProvider[],
  registerTool?: (gateway: UniversalToolGateway) => void,
  costAccounting?: TrustedCostAccountingPort,
) {
  const directory = await temporary.directory();
  const path = join(directory, "runtime.journal");
  const journal = await DurableJournal.open(path);
  const router = new ProviderRouter();
  providers.forEach((provider) => router.register(provider));
  const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), journal, undefined, journal.snapshot());
  registerTool?.(gateway);
  const coordinator = new RuntimeCoordinator(journal, router, gateway, costAccounting ?? zeroCostAccounting);
  await coordinator.createWorkspace(workspaceId, "Runtime tests", user);
  await coordinator.createConversation(workspaceId, conversationId, "One durable history", user);
  return { directory, path, journal, router, gateway, coordinator };
}

describe("RuntimeCoordinator", () => {
  it("evicts settled caches but rejects the 1,025th unresolved live entry without eviction", () => {
    const cache = new Map<number, string>();
    for (let index = 0; index <= MAX_COORDINATOR_CACHE_ENTRIES; index += 1) {
      setBoundedCacheEntry(cache, index, `value-${index}`);
    }
    expect(cache).toHaveLength(MAX_COORDINATOR_CACHE_ENTRIES);
    expect(cache.has(0)).toBe(false);
    expect(cache.get(MAX_COORDINATOR_CACHE_ENTRIES)).toBe(`value-${MAX_COORDINATOR_CACHE_ENTRIES}`);
    expect(() => setBoundedCacheEntry(cache, 1, "invalid", MAX_COORDINATOR_CACHE_ENTRIES + 1)).toThrow();

    const live = new Map<number, Promise<never>>();
    let oldest!: Promise<never>;
    for (let index = 0; index < MAX_COORDINATOR_CACHE_ENTRIES; index += 1) {
      const unresolved = new Promise<never>(() => undefined);
      if (index === 0) oldest = unresolved;
      setLiveStateEntry(live, index, unresolved);
    }
    expect(() => setLiveStateEntry(
      live,
      MAX_COORDINATOR_CACHE_ENTRIES,
      new Promise<never>(() => undefined),
    )).toThrow(RuntimeCapacityError);
    expect(live).toHaveLength(MAX_COORDINATOR_CACHE_ENTRIES);
    expect(live.get(0)).toBe(oldest);
  });

  it("protects one live paused result across more than 1,024 settled cache insertions", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.protected-paused-cache"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("protected-paused-cache", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "keep this exact proposal live" },
      summary: "Protect the paused result",
    })], undefined, undefined, [reviewed]);
    const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async () => ({ output: null, outputSummary: "not executed" }),
    }));
    const input = {
      workspaceId,
      conversationId,
      clientRequestId: "protected-paused-cache-send",
      content: "prepare one protected proposal",
      user,
      proposingAgent: agent,
      provider: providerSelection("protected-paused-cache", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
    };
    const paused = await coordinator.sendMessage(input);
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");

    const internals = coordinator as unknown as {
      completedRequests: Map<string, { readonly signature: string; readonly result: TurnResult }>;
      storeCompletedRequest(
        key: string,
        value: { readonly signature: string; readonly result: TurnResult },
      ): void;
    };
    const pausedKey = JSON.stringify([workspaceId, conversationId, input.clientRequestId]);
    for (let index = 0; index <= MAX_COORDINATOR_CACHE_ENTRIES; index += 1) {
      internals.storeCompletedRequest(`settled-${index}`, {
        signature: `settled-signature-${index}`,
        result: {
          status: "completed",
          turnId: asId<TurnId>(`turn-settled-${index}`),
          assistantText: `settled-${index}`,
          steps: 1,
          costUnits: 0,
        },
      });
    }

    expect(internals.completedRequests).toHaveLength(MAX_COORDINATOR_CACHE_ENTRIES);
    expect(internals.completedRequests.has(pausedKey)).toBe(true);
    expect(await coordinator.sendMessage(input)).toEqual(paused);
    expect(provider.requests).toHaveLength(1);
    expect(coordinator.cacheSizes().pendingProposals).toBe(1);
    await journal.close();
  });

  it("reserves active-turn capacity before durable acceptance across concurrent sends", async () => {
    const directory = await temporary.directory();
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const journal = await DurableJournal.open(join(directory, "active-capacity-reservation.journal"), {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "user.message.accepted")) {
            reached();
            await releasePromise;
          }
        },
      },
    });
    const provider = new ScriptedProvider("active-capacity", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(provider);
    const coordinator = new RuntimeCoordinator(
      journal,
      router,
      new UniversalToolGateway(new ToolPolicy("active-capacity-policy"), journal),
      zeroCostAccounting,
    );
    await coordinator.createWorkspace(workspaceId, "Active capacity", user);
    await coordinator.createConversation(workspaceId, conversationId, "Active capacity", user);
    const internals = coordinator as unknown as { activeTurnReservations: number };
    internals.activeTurnReservations = MAX_COORDINATOR_CACHE_ENTRIES - 1;
    const common = {
      workspaceId,
      conversationId,
      content: "reserve before acceptance",
      user,
      proposingAgent: agent,
      provider: providerSelection("active-capacity"),
      budget: generousBudget,
      policyContext,
    };
    const first = coordinator.sendMessage({ ...common, clientRequestId: "active-capacity-first" });
    await reachedPromise;
    await expect(coordinator.sendMessage({
      ...common,
      clientRequestId: "active-capacity-overflow",
    })).rejects.toBeInstanceOf(RuntimeCapacityError);
    expect(journal.snapshot().filter((event) => event.type === "user.message.accepted")).toHaveLength(0);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(journal.snapshot().filter((event) => event.type === "user.message.accepted")).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(internals.activeTurnReservations).toBe(MAX_COORDINATOR_CACHE_ENTRIES - 1);
    internals.activeTurnReservations = 0;
    await journal.close();
  });

  it("admits one exact immutable send snapshot before a blocked journal write", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.command-snapshot-read"),
      version: "1.0.0",
      effect: "external_read",
      dataScope: ["workspace/original"],
      networkScope: ["https://original.example"],
      idempotency: "idempotent",
    }, {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "send-command-snapshot.journal");
    let reached!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) =>
            event.type === "user.message.accepted" &&
            (event.payload as { clientRequestId?: string }).clientRequestId === "snapshot-send"
          )) {
            reached();
            await resume;
          }
        },
      },
    });
    const chosen = new ScriptedProvider("snapshot-send-provider", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { query: "original query" },
      summary: "Read the original scope",
    })], undefined, undefined, [reviewed]);
    const decoy = new ScriptedProvider("snapshot-send-decoy", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(chosen);
    router.register(decoy);
    const gateway = new UniversalToolGateway(new ToolPolicy("snapshot-send-policy"), journal);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async () => ({ output: null, outputSummary: "not executed" }),
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Snapshot workspace", user);
    await coordinator.createConversation(workspaceId, conversationId, "Snapshot conversation", user);

    const mutableUser = { kind: "human", id: "human-original", label: "Original human" };
    const mutableAgent = { kind: "agent", id: "agent-original", label: "Original agent" };
    const mutableProvider = {
      candidates: [{ providerId: "snapshot-send-provider", modelId: "test-model" }],
      requiredCapabilities: ["streaming", "tool_proposals"],
    };
    const mutableBudget = { maxSteps: 8, maxCostUnits: 10, maxDurationMs: 10_000 };
    const mutablePolicy = {
      grantedDataScopes: ["workspace/original"],
      grantedNetworkScopes: ["https://original.example"],
    };
    const mutableInput = {
      workspaceId: String(workspaceId),
      conversationId: String(conversationId),
      clientRequestId: "snapshot-send",
      content: "Original content",
      user: mutableUser,
      proposingAgent: mutableAgent,
      provider: mutableProvider,
      budget: mutableBudget,
      policyContext: mutablePolicy,
      signal: new AbortController().signal,
    };
    const operation = coordinator.sendMessage(mutableInput as unknown as SendMessageInput);
    await blocked;

    mutableInput.workspaceId = "ws-mutated";
    mutableInput.conversationId = "conversation-mutated";
    mutableInput.clientRequestId = "request-mutated";
    mutableInput.content = "Mutated content";
    mutableUser.kind = "agent";
    mutableUser.id = "human-mutated";
    mutableUser.label = "Mutated human";
    mutableAgent.kind = "human";
    mutableAgent.id = "agent-mutated";
    mutableAgent.label = "Mutated agent";
    mutableProvider.candidates[0].providerId = "snapshot-send-decoy";
    mutableProvider.candidates[0].modelId = "mutated-model";
    mutableProvider.requiredCapabilities.splice(0, mutableProvider.requiredCapabilities.length, "image_input");
    mutableBudget.maxSteps = 0;
    mutableBudget.maxCostUnits = -1;
    mutableBudget.maxDurationMs = -1;
    mutablePolicy.grantedDataScopes.splice(0, 1, "workspace/mutated");
    mutablePolicy.grantedNetworkScopes.splice(0, 1, "https://mutated.example");
    mutableInput.signal = AbortSignal.abort();
    release();

    const paused = await operation;
    expect(paused).toMatchObject({
      status: "paused",
      decision: { reasonCode: "provider_proposal_requires_exact_grant" },
      proposal: { actor: { kind: "agent", id: "agent-original", label: "Original agent" } },
    });
    expect(chosen.requests).toHaveLength(1);
    expect(decoy.requests).toHaveLength(0);
    const accepted = journal.snapshot().find((event) => event.type === "user.message.accepted");
    expect(accepted).toMatchObject({
      workspaceId,
      conversationId,
      actor: { kind: "human", id: "human-original", label: "Original human" },
      payload: { clientRequestId: "snapshot-send", content: "Original content" },
    });
    const proposed = journal.snapshot().find((event) => event.type === "tool.proposed");
    expect(proposed?.actor).toEqual({ kind: "agent", id: "agent-original", label: "Original agent" });
    await journal.close();
  });

  it("rejects non-exact command records and unauthentic signals before a durable write", async () => {
    const provider = new ScriptedProvider("strict-command", [chunks({ kind: "finish" })]);
    const { journal, coordinator } = await harness([provider]);
    const baseline = journal.snapshot().length;
    const valid = {
      workspaceId,
      conversationId,
      clientRequestId: "strict-command",
      content: "Strict command",
      user,
      proposingAgent: agent,
      provider: providerSelection("strict-command"),
      budget: generousBudget,
      policyContext,
    };
    await expect(coordinator.sendMessage({ ...valid, unexpected: true } as unknown as SendMessageInput))
      .rejects.toBeInstanceOf(RuntimeCommandValidationError);
    await expect(coordinator.sendMessage({
      ...valid,
      signal: { aborted: false },
    } as unknown as SendMessageInput)).rejects.toMatchObject({ field: "signal" });
    await expect(coordinator.sendMessage({
      ...valid,
      user: { ...user, unexpected: true },
    } as unknown as SendMessageInput)).rejects.toMatchObject({ field: "user" });
    const canary = "FORGED_RUNTIME_VALIDATION_CANARY_8f129d";
    const forged = Object.create(RuntimeCommandValidationError.prototype) as Error & {
      readonly cause: string;
    };
    Object.defineProperties(forged, {
      name: { value: `HOSTILE_NAME_${canary}`, enumerable: true },
      message: { value: `HOSTILE_MESSAGE_${canary}`, enumerable: true },
      field: { value: `HOSTILE_FIELD_${canary}`, enumerable: true },
      reasonCode: { value: `HOSTILE_REASON_${canary}`, enumerable: true },
      cause: { value: `HOSTILE_CAUSE_${canary}`, enumerable: true },
      stack: { value: `HOSTILE_STACK_${canary}`, enumerable: true },
    });
    const hostile = new Proxy(valid, {
      ownKeys: () => { throw forged; },
    });
    const caught = await coordinator.sendMessage(hostile as unknown as SendMessageInput).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(RuntimeCommandValidationError);
    expect(caught).not.toBe(forged);
    const sanitized = caught as Error & { readonly field?: unknown; readonly reasonCode?: unknown };
    expect(JSON.stringify({
      string: String(sanitized),
      name: sanitized.name,
      message: sanitized.message,
      stack: sanitized.stack,
      field: sanitized.field,
      reasonCode: sanitized.reasonCode,
      serialized: sanitized,
    })).not.toContain(canary);
    expect(journal.snapshot()).toHaveLength(baseline);
    expect(provider.requests).toHaveLength(0);
    await journal.close();
  });

  it("round-trips Korean, emoji, multiline, and normalization-sensitive text across multi-chunk streaming and restart", async () => {
    const assistantText = "체크 완료 🧭\nCafe\u0301와 Café는 그대로 둡니다.";
    const inputText = "한국어 🧪\nCafe\u0301 / Café\n끝";
    const provider = new ScriptedProvider("clarity", [chunks(
      { kind: "delta", text: "체크 완료 🧭\n", costUnits: 1 },
      { kind: "delta", text: "Cafe\u0301와 Café는 ", costUnits: 1 },
      { kind: "delta", text: "그대로 둡니다.", costUnits: 1 },
      { kind: "finish", costUnits: 0 },
    )]);
    const { path, journal, coordinator } = await harness([provider]);

    const result = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "unicode-request",
      content: inputText,
      user,
      proposingAgent: agent,
      provider: providerSelection("clarity"),
      budget: generousBudget,
      policyContext,
    });
    expect(result).toMatchObject({ status: "completed", assistantText });
    const before = projectConversation(journal.snapshot(), conversationId);
    expect(before.normalizedHistory.map((message) => message.content)).toEqual([inputText, assistantText]);
    expect(journal.snapshot().filter((event) => event.type === "assistant.stream.advanced")).toHaveLength(3);
    expect(journal.snapshot().filter((event) => event.type === "assistant.stream.completed")).toHaveLength(1);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    expect(projectConversation(reopened.snapshot(), conversationId)).toEqual(before);
    await reopened.close();
  });

  it("cancels upstream streaming, records the cancellation, and commits no partial assistant message", async () => {
    let releaseFirstChunk!: () => void;
    const firstChunkPersisting = new Promise<void>((resolve) => { releaseFirstChunk = resolve; });
    let upstreamObservedAbort = false;
    const provider = new ScriptedProvider("slow", [async function* (request) {
      yield { kind: "delta", text: "partial output" } as const;
      releaseFirstChunk();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          upstreamObservedAbort = true;
          reject(request.signal.reason);
        }, { once: true });
      });
      yield { kind: "delta", text: "must never commit" } as const;
    }]);
    const { journal, coordinator } = await harness([provider]);
    const external = new AbortController();
    const turn = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "cancel-request",
      content: "Stop this turn",
      user,
      proposingAgent: agent,
      provider: providerSelection("slow"),
      budget: generousBudget,
      policyContext,
      signal: external.signal,
    });
    await firstChunkPersisting;
    external.abort(new DOMException("User cancelled", "AbortError"));
    expect(await turn).toMatchObject({ status: "cancelled" });
    expect(upstreamObservedAbort).toBe(true);
    expect(projectConversation(journal.snapshot(), conversationId).normalizedHistory.map((item) => item.role)).toEqual([
      "user",
    ]);
    expect(journal.snapshot().some((event) => event.type === "assistant.stream.cancelled")).toBe(true);
    expect(journal.snapshot().some((event) => event.type === "assistant.stream.completed")).toBe(false);
    await journal.close();
  });

  it("linearizes abort before a provider journal commit and writes zero late deltas", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "abort-commit-race.journal");
    let reachedCommit!: () => void;
    let releaseCommit!: () => void;
    const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
    const commitRelease = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "assistant.stream.advanced")) {
            reachedCommit();
            await commitRelease;
          }
        },
      },
    });
    let providerCloses = 0;
    const provider = new ScriptedProvider("abort-race", [async function* () {
      try {
        yield { kind: "delta", text: "must-not-commit" } as const;
        yield { kind: "finish" } as const;
      } finally {
        providerCloses += 1;
      }
    }]);
    const router = new ProviderRouter();
    router.register(provider);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-abort-race"), journal);
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Abort race", user);
    await coordinator.createConversation(workspaceId, conversationId, "Abort race", user);
    const external = new AbortController();
    const turn = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "abort-commit-race",
      content: "race the commit",
      user,
      proposingAgent: agent,
      provider: providerSelection("abort-race"),
      budget: generousBudget,
      policyContext,
      signal: external.signal,
    });
    await commitReached;
    external.abort(new Error("secret abort detail"));
    releaseCommit();
    await expect(turn).resolves.toMatchObject({ status: "cancelled" });
    expect(journal.snapshot().filter((event) => event.type === "assistant.stream.advanced")).toHaveLength(0);
    expect(JSON.stringify(journal.snapshot())).not.toContain("must-not-commit");
    expect(JSON.stringify(journal.snapshot())).not.toContain("secret abort detail");
    expect(providerCloses).toBe(1);
    await journal.close();
  });

  it("lets a durable human stop win before assistant completion reaches the journal commit point", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "stop-completion-race.journal");
    let reachedCompletion!: () => void;
    let releaseCompletion!: () => void;
    const completionReached = new Promise<void>((resolve) => { reachedCompletion = resolve; });
    const completionRelease = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) =>
            event.type === "assistant.stream.completed" &&
            (event.payload as { stopReason?: string }).stopReason === "complete"
          )) {
            reachedCompletion();
            await completionRelease;
          }
        },
      },
    });
    let providerCloses = 0;
    const provider = new ScriptedProvider("stop-finish-race", [async function* () {
      try {
        yield { kind: "delta", text: "parsed before stop" } as const;
        yield { kind: "finish" } as const;
      } finally {
        providerCloses += 1;
      }
    }]);
    const router = new ProviderRouter();
    router.register(provider);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-stop-race"), journal);
    const coordinator = new RuntimeCoordinator(journal, router, gateway, {
      costForProviderChunk: ({ chunkKind }) => chunkKind === "delta" ? 4 : 7,
    });
    await coordinator.createWorkspace(workspaceId, "Stop race", user);
    await coordinator.createConversation(workspaceId, conversationId, "Stop race", user);
    const sendInput = {
      workspaceId,
      conversationId,
      clientRequestId: "stop-completion-race",
      content: "stop before terminal commit",
      user,
      proposingAgent: agent,
      provider: providerSelection("stop-finish-race"),
      budget: generousBudget,
      policyContext,
    };
    const send = coordinator.sendMessage(sendInput);
    await completionReached;
    const providerRequest = provider.requests[0];
    const stopInput = {
      workspaceId,
      conversationId,
      clientRequestId: "stop-completion-control",
      turnId: providerRequest.turnId,
      directionEpoch: providerRequest.directionEpoch ?? 1,
      human: user,
    };
    const stop = coordinator.stopTurn(stopInput);
    releaseCompletion();
    const stopped = await stop;
    expect(stopped).toMatchObject({
      status: "stopped",
      reasonCode: "human_stop",
      steps: 1,
      costUnits: 4,
    });
    expect(await send).toEqual(stopped);
    expect(journal.snapshot().filter((event) => event.type === "assistant.stream.completed")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "turn.stopped")).toHaveLength(1);
    expect(providerCloses).toBe(1);
    await expect(coordinator.stopTurn({
      workspaceId,
      conversationId,
      clientRequestId: "stop-after-terminal",
      turnId: providerRequest.turnId,
      directionEpoch: 1,
      human: user,
    })).rejects.toBeTruthy();
    await journal.close();
    const reopened = await DurableJournal.open(path);
    const shouldNotRun = new ScriptedProvider("stop-finish-race", [chunks({ kind: "finish" })]);
    const restartedRouter = new ProviderRouter();
    restartedRouter.register(shouldNotRun);
    const restarted = new RuntimeCoordinator(
      reopened,
      restartedRouter,
      new UniversalToolGateway(new ToolPolicy("policy-stop-race"), reopened, undefined, reopened.snapshot()),
      zeroCostAccounting,
    );
    expect(await restarted.sendMessage(sendInput)).toEqual(stopped);
    expect(await restarted.stopTurn(stopInput)).toEqual(stopped);
    expect(shouldNotRun.requests).toHaveLength(0);
    await reopened.close();
  });

  it("allows committed assistant completion to win when stop arrives after the journal commit point", async () => {
    const directory = await temporary.directory();
    const path = join(directory, "stop-after-completion-commit.journal");
    let committed!: () => void;
    let releaseAck!: () => void;
    const committedPromise = new Promise<void>((resolve) => { committed = resolve; });
    const releasePromise = new Promise<void>((resolve) => { releaseAck = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "after_sync_before_acknowledge" && events.some((event) =>
            event.type === "assistant.stream.completed" &&
            (event.payload as { stopReason?: string }).stopReason === "complete"
          )) {
            committed();
            await releasePromise;
          }
        },
      },
    });
    const provider = new ScriptedProvider("completion-wins", [chunks(
      { kind: "delta", text: "committed answer" },
      { kind: "finish" },
    )]);
    const router = new ProviderRouter();
    router.register(provider);
    const coordinator = new RuntimeCoordinator(
      journal,
      router,
      new UniversalToolGateway(new ToolPolicy("completion-wins-policy"), journal),
      zeroCostAccounting,
    );
    await coordinator.createWorkspace(workspaceId, "Completion wins", user);
    await coordinator.createConversation(workspaceId, conversationId, "Completion wins", user);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "completion-wins-send",
      content: "finish first",
      user,
      proposingAgent: agent,
      provider: providerSelection("completion-wins"),
      budget: generousBudget,
      policyContext,
    });
    await committedPromise;
    const providerRequest = provider.requests[0];
    await expect(coordinator.stopTurn({
      workspaceId,
      conversationId,
      clientRequestId: "completion-late-stop",
      turnId: providerRequest.turnId,
      directionEpoch: 1,
      human: user,
    })).rejects.toBeTruthy();
    releaseAck();
    await expect(send).resolves.toMatchObject({ status: "completed", assistantText: "committed answer" });
    expect(journal.snapshot().filter((event) => event.type === "turn.stopped")).toHaveLength(0);
    await journal.close();
  });

  it("deduplicates concurrent and restarted client request IDs to the original result", async () => {
    const provider = new ScriptedProvider("once", [chunks(
      { kind: "delta", text: "one result" },
      { kind: "finish" },
    )]);
    const { path, journal, coordinator } = await harness([provider]);
    const input = {
      workspaceId,
      conversationId,
      clientRequestId: "same-client-request",
      content: "Only once",
      user,
      proposingAgent: agent,
      provider: providerSelection("once"),
      budget: generousBudget,
      policyContext,
    };
    const [first, duplicate] = await Promise.all([coordinator.sendMessage(input), coordinator.sendMessage(input)]);
    expect(duplicate).toEqual(first);
    expect(await coordinator.sendMessage({
      ...input,
      user: { ...user, label: undefined },
      proposingAgent: { ...agent, label: undefined },
      signal: undefined,
    })).toEqual(first);
    expect(provider.requests).toHaveLength(1);
    expect(journal.snapshot().filter((event) => event.type === "user.message.accepted")).toHaveLength(1);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const nextRouter = new ProviderRouter();
    const shouldNotRun = new ScriptedProvider("once", [chunks({ kind: "delta", text: "duplicate" }, { kind: "finish" })]);
    nextRouter.register(shouldNotRun);
    const nextGateway = new UniversalToolGateway(new ToolPolicy("policy-1"), reopened, undefined, reopened.snapshot());
    const nextCoordinator = new RuntimeCoordinator(reopened, nextRouter, nextGateway, zeroCostAccounting);
    expect(await nextCoordinator.sendMessage(input)).toMatchObject({ status: "completed", assistantText: "one result" });
    expect(shouldNotRun.requests).toHaveLength(0);
    await reopened.close();
  });

  it("keeps request-cache identity collision-safe when IDs contain delimiters", async () => {
    const provider = new ScriptedProvider("tuple-request-key", [
      chunks({ kind: "delta", text: "first tuple" }, { kind: "finish" }),
      chunks({ kind: "delta", text: "second tuple" }, { kind: "finish" }),
    ]);
    const directory = await temporary.directory();
    const journal = await DurableJournal.open(join(directory, "tuple-request-key.journal"));
    const router = new ProviderRouter();
    router.register(provider);
    const coordinator = new RuntimeCoordinator(
      journal,
      router,
      new UniversalToolGateway(new ToolPolicy("tuple-request-key-policy"), journal),
      zeroCostAccounting,
    );
    const firstWorkspace = asId<WorkspaceId>("workspace:segment");
    const firstConversation = asId<ConversationId>("conversation");
    const secondWorkspace = asId<WorkspaceId>("workspace");
    const secondConversation = asId<ConversationId>("segment:conversation");
    await coordinator.createWorkspace(firstWorkspace, "First tuple", user);
    await coordinator.createConversation(firstWorkspace, firstConversation, "First tuple", user);
    await coordinator.createWorkspace(secondWorkspace, "Second tuple", user);
    await coordinator.createConversation(secondWorkspace, secondConversation, "Second tuple", user);
    const common = {
      clientRequestId: "same-client",
      content: "Same visible request",
      user,
      proposingAgent: agent,
      provider: providerSelection("tuple-request-key"),
      budget: generousBudget,
      policyContext,
    };
    expect(await coordinator.sendMessage({
      ...common,
      workspaceId: firstWorkspace,
      conversationId: firstConversation,
    })).toMatchObject({ status: "completed", assistantText: "first tuple" });
    expect(await coordinator.sendMessage({
      ...common,
      workspaceId: secondWorkspace,
      conversationId: secondConversation,
    })).toMatchObject({ status: "completed", assistantText: "second tuple" });
    expect(provider.requests).toHaveLength(2);
    await journal.close();
  });

  it("reconstructs nonzero trusted steps and cost when replaying a completed turn after restart", async () => {
    const provider = new ScriptedProvider("restart-accounting", [chunks(
      { kind: "delta", text: "accounted answer" },
      { kind: "finish" },
    )]);
    const trustedCost: TrustedCostAccountingPort = {
      costForProviderChunk: ({ chunkKind }) => chunkKind === "delta" ? 2 : 3,
    };
    const { path, journal, coordinator } = await harness([provider], undefined, trustedCost);
    const input = {
      workspaceId,
      conversationId,
      clientRequestId: "restart-accounting-send",
      content: "preserve accounting",
      user,
      proposingAgent: agent,
      provider: providerSelection("restart-accounting"),
      budget: generousBudget,
      policyContext,
    };
    const first = await coordinator.sendMessage(input);
    expect(first).toMatchObject({ status: "completed", steps: 2, costUnits: 5 });
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const shouldNotRun = new ScriptedProvider("restart-accounting", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(shouldNotRun);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), reopened, undefined, reopened.snapshot());
    const restarted = new RuntimeCoordinator(reopened, router, gateway, zeroCostAccounting);
    expect(await restarted.sendMessage(input)).toEqual(first);
    expect(shouldNotRun.requests).toHaveLength(0);
    await reopened.close();
  });

  it.each([
    { partial: false, reasonCode: "accepted_turn_requires_resume" },
    { partial: true, reasonCode: "interrupted_stream_requires_resume" },
  ])(
    "does not duplicate or rerun a durably accepted turn after a crash (partial stream: $partial)",
    async ({ partial, reasonCode }) => {
      const directory = await temporary.directory();
      const path = join(directory, `interrupted-${String(partial)}.journal`);
      const firstJournal = await DurableJournal.open(path);
      const turnId = asId<TurnId>(`turn-interrupted-${String(partial)}`);
      const base = {
        workspaceId,
        conversationId,
        actor: user,
        timestamp: "2026-08-26T00:00:00.000Z",
        payloadSchemaVersion: 1 as const,
      };
      await firstJournal.append({
        ...base,
        eventId: asId<EventId>(`event-accepted-${String(partial)}`),
        type: "user.message.accepted",
        payload: {
          messageId: asId<MessageId>(`message-interrupted-${String(partial)}`),
          turnId,
          clientRequestId: "interrupted-client-request",
          content: "Do not run this twice",
        },
      });
      if (partial) {
        await firstJournal.append({
          ...base,
          payloadSchemaVersion: 2,
          actor: { kind: "system", id: "provider-router" },
          eventId: asId<EventId>("event-partial-provider"),
          type: "provider.selected",
          payload: {
            turnId,
            providerId: asId<ProviderId>("must-not-run"),
            modelId: "test-model",
            protocolRevision: "fixture-1",
            credentialBindingRevision: "bind_fixture_must-not-run_00000001" as never,
            providerRequestId: "prv_fixture_request_00000001" as never,
            fallbackIndex: 0,
          },
        });
        await firstJournal.append({
          ...base,
          actor: { kind: "provider", id: "must-not-run" },
          eventId: asId<EventId>("event-partial-start"),
          type: "assistant.stream.started",
          payload: {
            streamId: "stream-partial",
            messageId: asId<MessageId>("message-partial-assistant"),
            turnId,
            providerId: asId<ProviderId>("must-not-run"),
          },
        });
        await firstJournal.append({
          ...base,
          actor: { kind: "provider", id: "must-not-run" },
          eventId: asId<EventId>("event-partial-delta"),
          type: "assistant.stream.advanced",
          payload: { streamId: "stream-partial", turnId, delta: "uncommitted partial", costUnits: 0 },
        });
      }
      await firstJournal.close();

      const reopened = await DurableJournal.open(path);
      const provider = new ScriptedProvider("must-not-run", [chunks(
        { kind: "delta", text: "duplicate execution" },
        { kind: "finish" },
      )]);
      const router = new ProviderRouter();
      router.register(provider);
      const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), reopened, undefined, reopened.snapshot());
      const coordinator = new RuntimeCoordinator(reopened, router, gateway, zeroCostAccounting);
      const retryInput = {
        workspaceId,
        conversationId,
        clientRequestId: "interrupted-client-request",
        content: "Do not run this twice",
        user,
        proposingAgent: agent,
        provider: providerSelection("must-not-run"),
        budget: generousBudget,
        policyContext,
      };
      expect(await coordinator.sendMessage(retryInput)).toMatchObject({
        status: "interrupted",
        turnId,
        reasonCode,
      });
      expect(await coordinator.sendMessage(retryInput)).toMatchObject({ status: "interrupted", turnId });
      expect(provider.requests).toHaveLength(0);
      expect(reopened.snapshot().filter((event) => event.type === "user.message.accepted")).toHaveLength(1);
      expect(projectConversation(reopened.snapshot(), conversationId).normalizedHistory.map((item) => item.role)).toEqual([
        "user",
      ]);
      await reopened.close();
    },
  );

  it("replays the exact earlier turn result rather than the conversation's latest assistant", async () => {
    const provider = new ScriptedProvider("replay-exact", [
      chunks({ kind: "delta", text: "first exact answer" }, { kind: "finish" }),
      chunks({ kind: "delta", text: "newer second answer" }, { kind: "finish" }),
    ]);
    const { path, journal, coordinator } = await harness([provider]);
    const common = {
      workspaceId,
      conversationId,
      user,
      proposingAgent: agent,
      provider: providerSelection("replay-exact"),
      budget: generousBudget,
      policyContext,
    };
    await coordinator.sendMessage({ ...common, clientRequestId: "earlier-key", content: "first" });
    await coordinator.sendMessage({ ...common, clientRequestId: "later-key", content: "second" });
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const shouldNotRun = new ScriptedProvider("replay-exact", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(shouldNotRun);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-1"), reopened, undefined, reopened.snapshot());
    const restarted = new RuntimeCoordinator(reopened, router, gateway, zeroCostAccounting);
    expect(await restarted.sendMessage({ ...common, clientRequestId: "earlier-key", content: "first" })).toMatchObject({
      status: "completed",
      assistantText: "first exact answer",
    });
    expect(shouldNotRun.requests).toHaveLength(0);
    expect(reopened.snapshot().filter((event) => event.type === "user.message.accepted")).toHaveLength(2);
    await reopened.close();
  });

  it("keeps concurrent conversations, cursors, and provider histories isolated", async () => {
    const provider = new ScriptedProvider("parallel", [
      async function* (request) {
        yield { kind: "delta", text: `answer:${request.conversationId}` } as const;
        yield { kind: "finish" } as const;
      },
      async function* (request) {
        yield { kind: "delta", text: `answer:${request.conversationId}` } as const;
        yield { kind: "finish" } as const;
      },
    ]);
    const { journal, coordinator } = await harness([provider]);
    const otherConversation = asId<ConversationId>("conv-other");
    await coordinator.createConversation(workspaceId, otherConversation, "Other timeline", user);

    await Promise.all([
      coordinator.sendMessage({
        workspaceId, conversationId, clientRequestId: "parallel-a", content: "alpha", user, proposingAgent: agent,
        provider: providerSelection("parallel"), budget: generousBudget, policyContext,
      }),
      coordinator.sendMessage({
        workspaceId, conversationId: otherConversation, clientRequestId: "parallel-b", content: "beta", user,
        proposingAgent: agent, provider: providerSelection("parallel"), budget: generousBudget, policyContext,
      }),
    ]);

    const first = projectConversation(journal.snapshot(), conversationId).normalizedHistory;
    const second = projectConversation(journal.snapshot(), otherConversation).normalizedHistory;
    expect(first.map((item) => item.content)).toEqual(["alpha", `answer:${conversationId}`]);
    expect(second.map((item) => item.content)).toEqual(["beta", `answer:${otherConversation}`]);
    for (const request of provider.requests) {
      expect(request.history.every((message) => message.kind !== "text" ||
        !["alpha", "beta"].includes(message.text) ||
        message.text === (request.conversationId === conversationId ? "alpha" : "beta"))).toBe(true);
    }
    await journal.close();
  });

  it("switches providers without fragmenting the normalized conversation history", async () => {
    const first = new ScriptedProvider("first", [chunks({ kind: "delta", text: "first answer" }, { kind: "finish" })]);
    const second = new ScriptedProvider("second", [chunks({ kind: "delta", text: "second answer" }, { kind: "finish" })]);
    const { journal, coordinator } = await harness([first, second]);
    await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "switch-1", content: "first question", user, proposingAgent: agent,
      provider: providerSelection("first"), budget: generousBudget, policyContext,
    });
    await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "switch-2", content: "second question", user, proposingAgent: agent,
      provider: providerSelection("second"), budget: generousBudget, policyContext,
    });

    expect(first.requests[0].history.map((item) => item.kind === "text" ? item.text : "tool")).toEqual(["first question"]);
    expect(second.requests[0].history.map((item) => item.kind === "text" ? item.text : "tool")).toEqual([
      "first question",
      "first answer",
      "second question",
    ]);
    await journal.close();
  });

  it("keeps proposal decision initialization failure-atomic before controller/listener allocation", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.atomic-decision"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("atomic-decision", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "keep pending" },
      summary: "Exercise atomic decision setup",
    })], undefined, undefined, [reviewed]);
    const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async () => ({ output: null, outputSummary: "must not execute" }),
    }));
    const chosenProvider = providerSelection("atomic-decision", ["streaming", "tool_proposals"]);
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "atomic-decision-send",
      content: "prepare one decision",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected an atomic-decision proposal");
    expect(coordinator.cacheSizes().pendingProposals).toBe(1);

    const external = new AbortController();
    vi.useFakeTimers();
    const listenerSpy = vi.spyOn(EventTarget.prototype, "addEventListener");
    try {
      await expect(coordinator.decideProposal({
        workspaceId,
        conversationId,
        clientRequestId: "atomic-decision-invalid-budget",
        turnId: paused.turnId,
        proposalId: paused.proposal.proposalId,
        disposition: "approve",
        approver,
        provider: chosenProvider,
        budget: { ...generousBudget, maxSteps: 0 },
        policyContext,
        signal: external.signal,
      })).rejects.toThrow("Runtime budgets");
      expect(vi.getTimerCount()).toBe(0);
      expect(listenerSpy).not.toHaveBeenCalled();
      expect(coordinator.cacheSizes().pendingProposals).toBe(1);

      const originalRevision = provider.credentialBindingRevision;
      Object.defineProperty(provider, "credentialBindingRevision", {
        configurable: true,
        value: "bind_fixture_atomic_decision_rotated_000000000000000000000001",
      });
      await expect(coordinator.decideProposal({
        workspaceId,
        conversationId,
        clientRequestId: "atomic-decision-rotated-binding",
        turnId: paused.turnId,
        proposalId: paused.proposal.proposalId,
        disposition: "approve",
        approver,
        provider: chosenProvider,
        budget: generousBudget,
        policyContext,
        signal: external.signal,
      })).rejects.toMatchObject({ reasonCode: "authority_changed" });
      expect(vi.getTimerCount()).toBe(0);
      expect(listenerSpy).not.toHaveBeenCalled();
      expect(coordinator.cacheSizes().pendingProposals).toBe(0);
      Object.defineProperty(provider, "credentialBindingRevision", {
        configurable: true,
        value: originalRevision,
      });
    } finally {
      listenerSpy.mockRestore();
      vi.useRealTimers();
    }
    expect(coordinator.cacheSizes().pendingProposals).toBe(0);
    await expect(coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "atomic-decision-send",
      content: "prepare one decision",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    })).resolves.toMatchObject({ status: "failed", reasonCode: "paused_turn_requires_fresh_proposal" });
    expect(provider.requests).toHaveLength(1);
    await journal.close();
  });

  it("binds a paused proposal to an immutable original budget ceiling", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.frozen-budget-authority"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("frozen-budget-authority", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "never execute under raised limits" },
      summary: "Test immutable budget authority",
    })], undefined, undefined, [reviewed]);
    const effects: string[] = [];
    const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    }));
    const chosenProvider = providerSelection("frozen-budget-authority", ["streaming", "tool_proposals"]);
    const originalBudget = { maxSteps: 5, maxCostUnits: 7, maxDurationMs: 10_000 };
    const mutableBudget = { ...originalBudget };
    const pausedPromise = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "frozen-budget-authority-send",
      content: "prepare under bounded authority",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: mutableBudget,
      policyContext,
    });
    Object.assign(mutableBudget, {
      maxSteps: 500,
      maxCostUnits: 700,
      maxDurationMs: 1_000_000,
    });
    const paused = await pausedPromise;
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");

    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "frozen-budget-authority-raised",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: mutableBudget,
      policyContext,
    })).rejects.toMatchObject({ reasonCode: "authority_changed" });
    for (const [index, raisedBudget] of [
      { ...originalBudget, maxSteps: originalBudget.maxSteps + 1 },
      { ...originalBudget, maxCostUnits: originalBudget.maxCostUnits + 1 },
      { ...originalBudget, maxDurationMs: originalBudget.maxDurationMs + 1 },
    ].entries()) {
      await expect(coordinator.decideProposal({
        workspaceId,
        conversationId,
        clientRequestId: `frozen-budget-authority-raised-${index}`,
        turnId: paused.turnId,
        proposalId: paused.proposal.proposalId,
        disposition: "approve",
        approver,
        provider: chosenProvider,
        budget: raisedBudget,
        policyContext,
      })).rejects.toMatchObject({ reasonCode: "authority_changed" });
    }
    expect(journal.snapshot().filter((event) => event.type === "approval.granted")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    expect(effects).toHaveLength(0);
    expect(coordinator.cacheSizes().pendingProposals).toBe(1);

    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "frozen-budget-authority-deny",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "deny",
      provider: chosenProvider,
      budget: originalBudget,
      policyContext,
    })).resolves.toMatchObject({ status: "denied" });
    await journal.close();
  });

  it("rejects an already-aborted proposal decision before grant issuance or accounting charge", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.aborted-decision"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("aborted-decision", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "must remain inert" },
      summary: "Abort before approval",
    })], undefined, undefined, [reviewed]);
    const effects: string[] = [];
    const { path, journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    }));
    const chosenProvider = providerSelection("aborted-decision", ["streaming", "tool_proposals"]);
    const sendInput = {
      workspaceId,
      conversationId,
      clientRequestId: "aborted-decision-send",
      content: "prepare then abort",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    };
    const paused = await coordinator.sendMessage(sendInput);
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    const aborted = new AbortController();
    aborted.abort(new Error("hostile abort detail"));
    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "aborted-decision-control",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
      signal: aborted.signal,
    })).rejects.toBeInstanceOf(ProviderTurnCancelledError);
    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "aborted-decision-deny",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "deny",
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
      signal: aborted.signal,
    })).rejects.toBeInstanceOf(ProviderTurnCancelledError);
    expect(journal.snapshot().filter((event) => event.type === "approval.granted")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "approval.consumed")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "approval.denied")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    expect(effects).toHaveLength(0);
    expect(coordinator.cacheSizes().pendingProposals).toBe(1);
    expect(await coordinator.sendMessage(sendInput)).toEqual(paused);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const shouldNotRun = new ScriptedProvider(
      "aborted-decision",
      [chunks({ kind: "finish" })],
      undefined,
      undefined,
      [reviewed],
    );
    const router = new ProviderRouter();
    router.register(shouldNotRun);
    const restarted = new RuntimeCoordinator(
      reopened,
      router,
      new UniversalToolGateway(new ToolPolicy("policy-1"), reopened, undefined, reopened.snapshot()),
      zeroCostAccounting,
    );
    expect(await restarted.sendMessage(sendInput)).toMatchObject({
      status: "failed",
      reasonCode: "paused_turn_requires_fresh_proposal",
      steps: paused.steps,
      costUnits: paused.costUnits,
    });
    expect(shouldNotRun.requests).toHaveLength(0);
    await reopened.close();
  });

  it("lets a durable terminal beat guarded tool start without reaching the executor", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.terminal-start-race"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "terminal-start-race.journal");
    const journal = await DurableJournal.open(path);
    let injected = false;
    const audit: ToolAuditPort = {
      append<Type extends AuditEventType>(draft: DraftAuditEvent<Type>) {
        return journal.append(draft);
      },
      appendGuarded<Type extends AuditEventType>(draft: DraftAuditEvent<Type>, guard: () => boolean) {
        return journal.appendGuarded(draft, guard);
      },
      async appendBatchGuarded(drafts: readonly DraftAuditEvent[], guard: () => boolean) {
        const started = drafts.find((draft) => draft.type === "tool.execution.started");
        if (!injected && started) {
          injected = true;
          await journal.append({
            eventId: asId<EventId>(randomUUID()),
            workspaceId,
            conversationId,
            actor: { kind: "system", id: "terminal-race-fixture" },
            timestamp: "2026-08-26T13:00:00.000Z",
            payloadSchemaVersion: 1,
            type: "turn.completed",
            payload: {
              turnId: (started.payload as { turnId: TurnId }).turnId,
              clientRequestId: "terminal-start-race-external",
              status: "completed",
            },
          });
        }
        return journal.appendBatchGuarded(drafts, guard);
      },
    };
    const provider = new ScriptedProvider("terminal-start-race", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "never execute" },
      summary: "Race a terminal against tool start",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("terminal-start-race-policy"), audit);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Terminal race", user);
    await coordinator.createConversation(workspaceId, conversationId, "Terminal race", user);
    const chosenProvider = providerSelection("terminal-start-race", ["streaming", "tool_proposals"]);
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "terminal-start-race-send",
      content: "prepare a guarded effect",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    const result = await coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "terminal-start-race-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    expect(result).toMatchObject({ status: "completed", steps: paused.steps, costUnits: paused.costUnits });
    expect(effects).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "approval.consumed")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "turn.failed")).toHaveLength(0);
    await journal.close();
  });

  it("rechecks provider authority at guarded tool start after a blocked grant", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.start-authority-race"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "start-authority-race.journal");
    let reachedGrant!: () => void;
    let releaseGrant!: () => void;
    const grantReached = new Promise<void>((resolve) => { reachedGrant = resolve; });
    const grantRelease = new Promise<void>((resolve) => { releaseGrant = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "approval.granted")) {
            reachedGrant();
            await grantRelease;
          }
        },
      },
    });
    const provider = new ScriptedProvider("start-authority-race", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "must not execute after rotation" },
      summary: "Rotate authority during grant",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("start-authority-race-policy"), journal);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Authority race", user);
    await coordinator.createConversation(workspaceId, conversationId, "Authority race", user);
    const chosenProvider = providerSelection("start-authority-race", ["streaming", "tool_proposals"]);
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "start-authority-race-send",
      content: "prepare guarded authority",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    const decision = coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "start-authority-race-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    await grantReached;
    const originalRevision = provider.credentialBindingRevision;
    Object.defineProperty(provider, "credentialBindingRevision", {
      configurable: true,
      value: "bind_fixture_start_authority_rotated_00000000000000000001",
    });
    releaseGrant();
    expect(await decision).toMatchObject({ status: "failed", reasonCode: "invalid_credential_binding" });
    expect(journal.snapshot().filter((event) => event.type === "approval.granted")).toHaveLength(1);
    expect(journal.snapshot().filter((event) => event.type === "approval.consumed")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    expect(effects).toHaveLength(0);
    Object.defineProperty(provider, "credentialBindingRevision", {
      configurable: true,
      value: originalRevision,
    });
    await journal.close();
  });

  it("burns a grant when abort arrives while approval.granted is blocked", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.abort-during-grant"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "abort-during-grant.journal");
    let reachedGrant!: () => void;
    let releaseGrant!: () => void;
    const grantReached = new Promise<void>((resolve) => { reachedGrant = resolve; });
    const grantRelease = new Promise<void>((resolve) => { releaseGrant = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "approval.granted")) {
            reachedGrant();
            await grantRelease;
          }
        },
      },
    });
    const provider = new ScriptedProvider("abort-during-grant", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "must remain inert" },
      summary: "Abort during grant persistence",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("abort-during-grant-policy"), journal);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Abort during grant", user);
    await coordinator.createConversation(workspaceId, conversationId, "Abort during grant", user);
    const chosenProvider = providerSelection("abort-during-grant", ["streaming", "tool_proposals"]);
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "abort-during-grant-send",
      content: "prepare a grant",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused grant fixture");
    const pending = coordinator as unknown as {
      pendingProposals: Map<ProposalId, { readonly proposal: PreparedToolProposal }>;
    };
    const prepared = pending.pendingProposals.get(paused.proposal.proposalId)?.proposal;
    if (!prepared) throw new Error("Expected a prepared proposal");
    const controller = new AbortController();
    const decision = coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "abort-during-grant-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
      signal: controller.signal,
    });
    await grantReached;
    controller.abort(new Error("hostile abort detail"));
    releaseGrant();
    await expect(decision).resolves.toMatchObject({ status: "failed" });
    const granted = journal.snapshot().find((event) => event.type === "approval.granted");
    const grant = (granted?.payload as { grant?: ApprovalGrant } | undefined)?.grant;
    if (!grant) throw new Error("Expected a durable grant");
    expect(journal.snapshot().filter((event) => event.type === "approval.consumed")).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toEqual([]);
    expect(effects).toEqual([]);
    const assertEveryPathBlocked = async (current: UniversalToolGateway) => {
      const execution = { proposal: prepared, grant, policyContext, requireExactGrant: true };
      for (const attempt of [
        () => current.executeDirect(execution),
        () => current.executeRouted(execution),
        () => current.executeRetry(execution),
        () => current.executeResume(execution),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ reasonCode: "reconciliation_required" });
      }
    };
    await assertEveryPathBlocked(gateway);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const recovered = new UniversalToolGateway(
      new ToolPolicy("abort-during-grant-policy"),
      reopened,
      undefined,
      reopened.snapshot(),
    );
    recovered.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    });
    await assertEveryPathBlocked(recovered);
    expect(effects).toEqual([]);
    await reopened.close();
  });

  it("rechecks the total deadline at guarded tool start after a blocked grant", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.start-deadline-race"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const clock = new MutableClock(Date.parse("2026-08-26T15:00:00.000Z"));
    const directory = await temporary.directory();
    const path = join(directory, "start-deadline-race.journal");
    let reachedGrant!: () => void;
    let releaseGrant!: () => void;
    const grantReached = new Promise<void>((resolve) => { reachedGrant = resolve; });
    const grantRelease = new Promise<void>((resolve) => { releaseGrant = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "approval.granted")) {
            reachedGrant();
            await grantRelease;
          }
        },
      },
    });
    const provider = new ScriptedProvider("start-deadline-race", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "must not execute after deadline" },
      summary: "Expire during grant",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(
      new ToolPolicy("start-deadline-race-policy", clock),
      journal,
      clock,
    );
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting, clock);
    await coordinator.createWorkspace(workspaceId, "Deadline race", user);
    await coordinator.createConversation(workspaceId, conversationId, "Deadline race", user);
    const chosenProvider = providerSelection("start-deadline-race", ["streaming", "tool_proposals"]);
    const deadlineBudget = { maxSteps: 10, maxCostUnits: 10, maxDurationMs: 1_000 };
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "start-deadline-race-send",
      content: "prepare before deadline",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: deadlineBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    const decision = coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "start-deadline-race-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: deadlineBudget,
      policyContext,
    });
    await grantReached;
    clock.advance(deadlineBudget.maxDurationMs);
    releaseGrant();
    expect(await decision).toMatchObject({ status: "failed", reasonCode: "time_budget" });
    expect(journal.snapshot().filter((event) => event.type === "approval.granted")).toHaveLength(1);
    expect(journal.snapshot().filter((event) => event.type === "approval.consumed")).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    expect(effects).toHaveLength(0);
    await journal.close();
  });

  it("uses one immutable proposal-decision snapshot across a blocked grant await", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.decision-command-snapshot"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/original"],
      networkScope: ["https://original.example"],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "decision-command-snapshot.journal");
    let reached!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) => event.type === "approval.granted")) {
            reached();
            await resume;
          }
        },
      },
    });
    const provider = new ScriptedProvider("decision-snapshot", [
      chunks({
        kind: "tool_proposal",
        toolId: reviewed.toolId,
        arguments: { text: "original effect" },
        summary: "Execute with captured authority",
      }),
      chunks({ kind: "delta", text: "captured decision" }, { kind: "finish" }),
    ], undefined, undefined, [reviewed]);
    const decoy = new ScriptedProvider("decision-snapshot-decoy", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(provider);
    router.register(decoy);
    const observedContexts: Array<{ data: readonly string[]; network: readonly string[] }> = [];
    const policy = new ToolPolicy("decision-snapshot-policy");
    const evaluate = policy.evaluate.bind(policy);
    vi.spyOn(policy, "evaluate").mockImplementation((proposal, context) => {
      observedContexts.push({
        data: [...context.grantedDataScopes],
        network: [...context.grantedNetworkScopes],
      });
      return evaluate(proposal, context);
    });
    const gateway = new UniversalToolGateway(policy, journal);
    const effects: string[] = [];
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "captured effect" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Decision snapshot", user);
    await coordinator.createConversation(workspaceId, conversationId, "Decision snapshot", user);
    const originalSelection = providerSelection("decision-snapshot", ["streaming", "tool_proposals"]);
    const originalPolicy = {
      grantedDataScopes: ["workspace/original"],
      grantedNetworkScopes: ["https://original.example"],
    };
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "decision-snapshot-send",
      content: "Prepare the captured decision",
      user,
      proposingAgent: agent,
      provider: originalSelection,
      budget: generousBudget,
      policyContext: originalPolicy,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    observedContexts.splice(0);

    const mutableApprover = {
      principalId: "human-decision-original",
      kind: "human",
      assurance: "authenticated_control_plane",
    };
    const mutableProvider = {
      candidates: [{ providerId: "decision-snapshot", modelId: "test-model" }],
      requiredCapabilities: ["streaming", "tool_proposals"],
    };
    const mutableBudget = { maxSteps: 10, maxCostUnits: 10, maxDurationMs: 10_000 };
    const mutablePolicy = {
      grantedDataScopes: ["workspace/original"],
      grantedNetworkScopes: ["https://original.example"],
    };
    const mutableDecision = {
      workspaceId: String(workspaceId),
      conversationId: String(conversationId),
      clientRequestId: "decision-snapshot-command",
      turnId: String(paused.turnId),
      proposalId: String(paused.proposal.proposalId),
      disposition: "approve",
      approver: mutableApprover,
      provider: mutableProvider,
      budget: mutableBudget,
      policyContext: mutablePolicy,
      signal: new AbortController().signal,
    };
    const operation = coordinator.decideProposal(mutableDecision as unknown as ProposalDecisionInput);
    await blocked;

    mutableDecision.workspaceId = "ws-mutated";
    mutableDecision.conversationId = "conversation-mutated";
    mutableDecision.clientRequestId = "decision-mutated";
    mutableDecision.turnId = "turn-mutated";
    mutableDecision.proposalId = "proposal-mutated";
    mutableDecision.disposition = "deny";
    mutableApprover.principalId = "human-mutated";
    mutableApprover.kind = "agent";
    mutableApprover.assurance = "model_claim";
    mutableProvider.candidates[0].providerId = "decision-snapshot-decoy";
    mutableProvider.candidates[0].modelId = "mutated-model";
    mutableProvider.requiredCapabilities.splice(0, mutableProvider.requiredCapabilities.length, "image_input");
    mutableBudget.maxSteps = 0;
    mutableBudget.maxCostUnits = -1;
    mutableBudget.maxDurationMs = -1;
    mutablePolicy.grantedDataScopes.splice(0, 1, "workspace/mutated");
    mutablePolicy.grantedNetworkScopes.splice(0, 1, "https://mutated.example");
    mutableDecision.signal = AbortSignal.abort();
    release();

    expect(await operation).toEqual({
      status: "failed",
      turnId: paused.turnId,
      reasonCode: "incomplete_durable_tool_history",
      steps: 2,
      costUnits: 0,
    });
    expect(effects).toHaveLength(1);
    expect(decoy.requests).toHaveLength(0);
    expect(observedContexts.length).toBeGreaterThanOrEqual(2);
    expect(observedContexts.every((context) =>
      context.data.join() === "workspace/original" &&
      context.network.join() === "https://original.example"
    )).toBe(true);
    const granted = journal.snapshot().find((event) => event.type === "approval.granted");
    expect(granted?.payload).toMatchObject({ grant: { principalId: "human-decision-original" } });
    const failed = [...journal.snapshot()].reverse().find((event) => event.type === "turn.failed");
    expect(failed?.payload).toMatchObject({ clientRequestId: "decision-snapshot-command" });
    await journal.close();
  });

  it("never revives a durable terminal when the provider proposes a tool afterward", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.preproposal-terminal"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    let providerBlocked!: () => void;
    let releaseProvider!: () => void;
    const blocked = new Promise<void>((resolve) => { providerBlocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const provider = new ScriptedProvider("preproposal-terminal", [async function* () {
      providerBlocked();
      await release;
      yield {
        kind: "tool_proposal",
        providerItemId: "item_preproposal_terminal",
        providerCallId: "call_preproposal_terminal",
        toolId: reviewed.toolId,
        arguments: { text: "must remain inert" },
        summary: "Must not revive a terminal",
      } as const;
    }], undefined, undefined, [reviewed]);
    const effects: string[] = [];
    const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    }));
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "preproposal-terminal-send",
      content: "block before proposing",
      user,
      proposingAgent: agent,
      provider: providerSelection("preproposal-terminal", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
    });
    await blocked;
    const turnId = provider.requests[0].turnId;
    await journal.append({
      eventId: asId<EventId>("event-preproposal-terminal"),
      workspaceId,
      conversationId,
      actor: { kind: "system", id: "preproposal-terminal-fixture" },
      timestamp: "2026-08-26T15:00:00.000Z",
      payloadSchemaVersion: 1,
      type: "turn.completed",
      payload: {
        turnId,
        clientRequestId: "preproposal-terminal-external",
        status: "completed",
      },
    });
    releaseProvider();
    await expect(send).resolves.toMatchObject({ status: "completed", turnId });
    expect(effects).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "tool.proposed")).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "approval.granted")).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "tool.execution.started")).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "turn.failed")).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "turn.completed")).toHaveLength(1);
    await journal.close();
  });

  it("lets a durable terminal beat a concurrently guarded denial", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.denial-terminal-race"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const journal = await DurableJournal.open(join(directory, "denial-terminal-race.journal"));
    let injected = false;
    const audit: ToolAuditPort = {
      append<Type extends AuditEventType>(draft: DraftAuditEvent<Type>) {
        return journal.append(draft);
      },
      async appendGuarded<Type extends AuditEventType>(draft: DraftAuditEvent<Type>, guard: () => boolean) {
        if (!injected && draft.type === "approval.denied") {
          injected = true;
          await journal.append({
            eventId: asId<EventId>("event-denial-terminal-race"),
            workspaceId,
            conversationId,
            actor: { kind: "system", id: "denial-terminal-fixture" },
            timestamp: "2026-08-26T15:01:00.000Z",
            payloadSchemaVersion: 1,
            type: "turn.completed",
            payload: {
              turnId: (draft.payload as { turnId: TurnId }).turnId,
              clientRequestId: "denial-terminal-external",
              status: "completed",
            },
          });
        }
        return journal.appendGuarded(draft, guard);
      },
      appendBatchGuarded(drafts: readonly DraftAuditEvent[], guard: () => boolean) {
        return journal.appendBatchGuarded(drafts, guard);
      },
    };
    const provider = new ScriptedProvider("denial-terminal-race", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "deny without revival" },
      summary: "Race denial against a terminal",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("denial-terminal-race-policy"), audit);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Denial terminal race", user);
    await coordinator.createConversation(workspaceId, conversationId, "Denial terminal race", user);
    const chosenProvider = providerSelection("denial-terminal-race", ["streaming", "tool_proposals"]);
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "denial-terminal-race-send",
      content: "prepare a denial",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused denial fixture");
    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "denial-terminal-race-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "deny",
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    })).resolves.toMatchObject({ status: "completed", turnId: paused.turnId });
    expect(effects).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "approval.denied")).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "turn.failed")).toEqual([]);
    expect(journal.snapshot().filter((event) =>
      event.type === "turn.completed" &&
      (event.payload as { status?: string }).status === "denied"
    )).toEqual([]);
    expect(journal.snapshot().filter((event) => event.type === "turn.completed")).toHaveLength(2);
    await journal.close();
  });

  it("publishes no executable proposal when the durable paused terminal write fails", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.pause-write-failure"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "pause-write-failure.journal");
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: (phase, events) => {
          if (phase === "before_write" && events.some((event) =>
            event.type === "turn.completed" &&
            (event.payload as { status?: string }).status === "paused"
          )) {
            throw new Error("fixture paused terminal write failure");
          }
        },
      },
    });
    const provider = new ScriptedProvider("pause-write-failure", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "must remain inert" },
      summary: "Exercise paused terminal failure",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const effects: string[] = [];
    const gateway = new UniversalToolGateway(new ToolPolicy("pause-write-failure-policy"), journal);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "must not execute" };
      },
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Pause failure", user);
    await coordinator.createConversation(workspaceId, conversationId, "Pause failure", user);
    const chosenProvider = providerSelection("pause-write-failure", ["streaming", "tool_proposals"]);

    const result = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "pause-write-failure-send",
      content: "prepare but do not publish",
      user,
      proposingAgent: agent,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    });

    expect(result).toMatchObject({ status: "failed", reasonCode: "unknown_failure" });
    expect(coordinator.cacheSizes().pendingProposals).toBe(0);
    expect(effects).toHaveLength(0);
    expect(journal.snapshot().filter((event) =>
      event.type === "turn.completed" &&
      (event.payload as { status?: string }).status === "paused"
    )).toHaveLength(0);
    expect(journal.snapshot().filter((event) => event.type === "turn.failed")).toHaveLength(1);
    const proposal = journal.snapshot().find((event) => event.type === "tool.proposed");
    if (!proposal || proposal.type !== "tool.proposed") throw new Error("Expected a durable proposal audit event");
    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "pause-write-failure-send",
      turnId: result.turnId,
      proposalId: (proposal.payload as { proposal: { proposalId: ProposalId } }).proposal.proposalId,
      disposition: "approve",
      approver,
      provider: chosenProvider,
      budget: generousBudget,
      policyContext,
    })).rejects.toThrow("No live prepared effect");
    expect(effects).toHaveLength(0);
    await journal.close();
  });

  it.each(["completed", "denied", "failed", "stopped"] as const)(
    "rejects a cached proposal after a later durable %s terminal without executing it",
    async (terminalKind) => {
      const reviewed = reviewedFixtureTool({
        toolId: asId<ToolId>(`tool.terminal-bypass-${terminalKind}`),
        version: "1.0.0",
        effect: "write",
        dataScope: ["workspace/notes"],
        networkScope: [],
        idempotency: "non_idempotent",
      }, {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      });
      const providerId = `terminal-bypass-${terminalKind}`;
      const provider = new ScriptedProvider(providerId, [chunks({
        kind: "tool_proposal",
        toolId: reviewed.toolId,
        arguments: { text: "must not execute" },
        summary: "Exercise terminal-state bypass",
      })], undefined, undefined, [reviewed]);
      const effects: string[] = [];
      const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
        manifest: reviewed.manifest,
        execute: async ({ idempotencyKey }) => {
          effects.push(idempotencyKey);
          return { output: null, outputSummary: "must not execute" };
        },
      }));
      const chosenProvider = providerSelection(providerId, ["streaming", "tool_proposals"]);
      const paused = await coordinator.sendMessage({
        workspaceId,
        conversationId,
        clientRequestId: `terminal-bypass-${terminalKind}-send`,
        content: "prepare one proposal",
        user,
        proposingAgent: agent,
        provider: chosenProvider,
        budget: generousBudget,
        policyContext,
      });
      if (paused.status !== "paused") throw new Error("Expected a paused proposal");

      const timestamp = "2026-08-26T12:34:56.000Z";
      if (terminalKind === "failed") {
        await journal.append({
          eventId: asId<EventId>(`event-terminal-bypass-${terminalKind}`),
          workspaceId,
          conversationId,
          actor: { kind: "system", id: "terminal-bypass-fixture" },
          timestamp,
          payloadSchemaVersion: 1,
          type: "turn.failed",
          payload: {
            turnId: paused.turnId,
            clientRequestId: `terminal-bypass-${terminalKind}-send`,
            reasonCode: "fixture_terminal",
          },
        });
      } else if (terminalKind === "stopped") {
        const controlId = "control-terminal-bypass-stopped";
        await journal.appendBatch([
          {
            eventId: asId<EventId>("event-terminal-bypass-stop-request"),
            workspaceId,
            conversationId,
            actor: user,
            timestamp,
            payloadSchemaVersion: 1,
            type: "human.control.requested",
            payload: {
              controlId,
              controlKind: "stop",
              turnId: paused.turnId,
              clientRequestId: "terminal-bypass-stopped-control",
              directionEpoch: 1,
              directionHash: canonicalHash("stop"),
              requestedAt: timestamp,
            },
          },
          {
            eventId: asId<EventId>("event-terminal-bypass-stopped"),
            workspaceId,
            conversationId,
            actor: { kind: "system", id: "terminal-bypass-fixture" },
            timestamp,
            payloadSchemaVersion: 1,
            type: "turn.stopped",
            payload: {
              controlId,
              turnId: paused.turnId,
              clientRequestId: "terminal-bypass-stopped-control",
              directionEpoch: 1,
              reasonCode: "human_stop",
              stoppedAt: timestamp,
            },
          },
        ]);
      } else {
        await journal.append({
          eventId: asId<EventId>(`event-terminal-bypass-${terminalKind}`),
          workspaceId,
          conversationId,
          actor: { kind: "system", id: "terminal-bypass-fixture" },
          timestamp,
          payloadSchemaVersion: 1,
          type: "turn.completed",
          payload: {
            turnId: paused.turnId,
            clientRequestId: `terminal-bypass-${terminalKind}-send`,
            status: terminalKind,
          },
        });
        if (terminalKind === "completed") {
          await journal.append({
            eventId: asId<EventId>("event-terminal-bypass-revival-paused"),
            workspaceId,
            conversationId,
            actor: { kind: "system", id: "terminal-bypass-fixture" },
            timestamp,
            payloadSchemaVersion: 1,
            type: "turn.completed",
            payload: {
              turnId: paused.turnId,
              clientRequestId: "terminal-bypass-revival-paused",
              status: "paused",
            },
          });
        }
      }

      await expect(coordinator.decideProposal({
        workspaceId,
        conversationId,
        clientRequestId: `terminal-bypass-${terminalKind}-decision`,
        turnId: paused.turnId,
        proposalId: paused.proposal.proposalId,
        disposition: "approve",
        approver,
        provider: chosenProvider,
        budget: generousBudget,
        policyContext,
      })).rejects.toBeInstanceOf(StaleTurnControlError);
      expect(coordinator.cacheSizes().pendingProposals).toBe(0);
      expect(effects).toHaveLength(0);
      expect(journal.snapshot().some((event) => event.type === "tool.execution.started")).toBe(false);
      await journal.close();
    },
  );

  it("prunes 1,024 externally terminalized proposal authorities before reserving capacity", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.stale-capacity"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("stale-capacity", [chunks({
      kind: "tool_proposal",
      toolId: reviewed.toolId,
      arguments: { text: "become stale" },
      summary: "Fill stale authority slots",
    })], undefined, undefined, [reviewed]);
    const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async () => ({ output: null, outputSummary: "must not execute" }),
    }));
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "stale-capacity-send",
      content: "prepare stale authority",
      user,
      proposingAgent: agent,
      provider: providerSelection("stale-capacity", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    const timestamp = "2026-08-26T14:00:00.000Z";
    await journal.append({
      eventId: asId<EventId>("event-stale-capacity-terminal"),
      workspaceId,
      conversationId,
      actor: { kind: "system", id: "stale-capacity-fixture" },
      timestamp,
      payloadSchemaVersion: 1,
      type: "turn.completed",
      payload: {
        turnId: paused.turnId,
        clientRequestId: "stale-capacity-terminal",
        status: "completed",
      },
    });

    type PendingAuthority = {
      readonly proposal: PreparedToolProposal;
      readonly budget: typeof generousBudget;
      readonly providerPlanSignature: string;
    };
    const internals = coordinator as unknown as {
      pendingProposals: Map<ProposalId, PendingAuthority>;
      reservePendingProposalSlot(proposalId: ProposalId): () => void;
    };
    const original = [...internals.pendingProposals.values()][0];
    if (!original) throw new Error("Expected a pending authority fixture");
    internals.pendingProposals.clear();
    for (let index = 0; index < MAX_COORDINATOR_CACHE_ENTRIES; index += 1) {
      const proposalId = asId<ProposalId>(`proposal-stale-capacity-${index}`);
      internals.pendingProposals.set(proposalId, {
        ...original,
        proposal: Object.freeze({ ...original.proposal, proposalId }),
      });
    }
    const freshId = asId<ProposalId>("proposal-fresh-capacity-slot");
    const release = internals.reservePendingProposalSlot(freshId);
    release();
    expect(internals.pendingProposals).toHaveLength(0);
    expect(coordinator.cacheSizes().pendingProposals).toBe(0);
    await journal.close();
  });

  it("pauses for an exact mutation approval, resumes with its receipt, and preserves a complete causal chain", async () => {
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.write-note"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("tools", [
      chunks({
        kind: "tool_proposal",
        toolId: asId<ToolId>("tool.write-note"),
        arguments: { text: "approved note" },
        summary: "Write one note",
      }),
      chunks({ kind: "delta", text: "The approved note was stored." }, { kind: "finish" }),
    ], undefined, undefined, [reviewed]);
    const externalEffects: string[] = [];
    const { journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async ({ idempotencyKey }) => {
        externalEffects.push(idempotencyKey);
        return { output: { noteId: "note-1" }, outputSummary: "Stored note note-1." };
      },
    }));

    const paused = await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "tool-turn", content: "Store a note", user, proposingAgent: agent,
      provider: providerSelection("tools", ["streaming", "tool_proposals"]), budget: generousBudget, policyContext,
    });
    expect(paused.status).toBe("paused");
    expect(externalEffects).toHaveLength(0);
    if (paused.status !== "paused") throw new Error("Expected pause");

    const completed = await coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "tool-turn",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: providerSelection("tools", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
    });
    expect(completed).toMatchObject({ status: "failed", reasonCode: "incomplete_durable_tool_history" });
    expect(externalEffects).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(projectConversation(journal.snapshot(), conversationId).normalizedHistory.map((item) => item.role)).toEqual([
      "user", "assistant", "tool",
    ]);
    const causal = journal.snapshot().map((event) => event.type);
    const expectedOrder: AuditEventType[] = [
      "provider.selected",
      "tool.proposed",
      "policy.decided",
      "approval.granted",
      "approval.consumed",
      "tool.execution.started",
      "tool.execution.succeeded",
      "turn.failed",
    ];
    let cursor = -1;
    for (const type of expectedOrder) {
      cursor = causal.indexOf(type, cursor + 1);
      expect(cursor, type).toBeGreaterThanOrEqual(0);
    }
    expect(await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "tool-turn", content: "Store a note", user, proposingAgent: agent,
      provider: providerSelection("tools", ["streaming", "tool_proposals"]), budget: generousBudget, policyContext,
    })).toMatchObject({ status: "failed", reasonCode: "incomplete_durable_tool_history" });
    expect(provider.requests).toHaveLength(1);
    await journal.close();
  });

  it("reconstructs trusted provider step and cost usage across a tool pause without treating token usage as cost", async () => {
    const toolId = asId<ToolId>("tool.budget-bound-write");
    const reviewed = reviewedFixtureTool({
      toolId,
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const manifest = reviewed.manifest;

    const stepEffects: string[] = [];
    const stepProvider = new ScriptedProvider("pause-step-budget", [chunks(
      { kind: "delta", text: "" },
      {
        kind: "tool_proposal",
        toolId,
        arguments: { text: "must stay paused" },
        summary: "Try one bounded write",
      },
    )], undefined, undefined, [reviewed]);
    const stepHarness = await harness([stepProvider], (gateway) => gateway.registerTool({
      manifest,
      execute: async ({ idempotencyKey }) => {
        stepEffects.push(idempotencyKey);
        return { output: null, outputSummary: "Unexpected write." };
      },
    }));
    const stepBudget = { maxSteps: 2, maxCostUnits: 100, maxDurationMs: 10_000 };
    const stepPaused = await stepHarness.coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "pause-step-budget",
      content: "Propose a bounded write",
      user,
      proposingAgent: agent,
      provider: providerSelection("pause-step-budget", ["streaming", "tool_proposals"]),
      budget: stepBudget,
      policyContext,
    });
    expect(stepPaused).toMatchObject({ status: "paused", steps: 2, costUnits: 0 });
    if (stepPaused.status !== "paused") throw new Error("Expected step-budget pause");
    expect(await stepHarness.coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "pause-step-budget",
      turnId: stepPaused.turnId,
      proposalId: stepPaused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: providerSelection("pause-step-budget", ["streaming", "tool_proposals"]),
      budget: stepBudget,
      policyContext,
    })).toMatchObject({ status: "failed", reasonCode: "step_budget", steps: 2, costUnits: 0 });
    expect(stepEffects).toHaveLength(0);
    expect(stepProvider.requests).toHaveLength(1);
    expect(stepHarness.journal.snapshot().filter((event) => event.type === "approval.granted")).toHaveLength(0);
    expect(stepHarness.journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    expect(stepHarness.journal.snapshot().some((event) =>
      event.type === "assistant.stream.advanced" && "delta" in event.payload && event.payload.delta === ""
    )).toBe(true);
    await stepHarness.journal.close();

    const costEffects: string[] = [];
    const costKinds: ProviderChunk["kind"][] = [];
    const costProvider = new ScriptedProvider("pause-cost-budget", [chunks(
      { kind: "usage", usage: { inputTokens: 500_000, outputTokens: 250_000, totalTokens: 750_000 } },
      {
        kind: "tool_proposal",
        toolId,
        arguments: { text: "must remain cost bounded" },
        summary: "Try one cost-bounded write",
      },
    )], undefined, undefined, [reviewed]);
    const costHarness = await harness(
      [costProvider],
      (gateway) => gateway.registerTool({
        manifest,
        execute: async ({ idempotencyKey }) => {
          costEffects.push(idempotencyKey);
          return { output: null, outputSummary: "Unexpected write." };
        },
      }),
      {
        costForProviderChunk: ({ chunkKind }) => {
          costKinds.push(chunkKind);
          return chunkKind === "tool_proposal" ? 3 : 0;
        },
      },
    );
    const costPaused = await costHarness.coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "pause-cost-budget",
      content: "Propose a cost-bounded write",
      user,
      proposingAgent: agent,
      provider: providerSelection("pause-cost-budget", ["streaming", "tool_proposals", "usage"]),
      budget: { maxSteps: 10, maxCostUnits: 3, maxDurationMs: 10_000 },
      policyContext,
    });
    expect(costPaused).toMatchObject({ status: "paused", steps: 1, costUnits: 3 });
    expect(costKinds).toEqual(["tool_proposal"]);
    if (costPaused.status !== "paused") throw new Error("Expected cost-budget pause");
    expect(await costHarness.coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "pause-cost-budget",
      turnId: costPaused.turnId,
      proposalId: costPaused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: providerSelection("pause-cost-budget", ["streaming", "tool_proposals", "usage"]),
      budget: { maxSteps: 10, maxCostUnits: 2, maxDurationMs: 10_000 },
      policyContext,
    })).toMatchObject({ status: "failed", reasonCode: "cost_budget", steps: 1, costUnits: 3 });
    expect(costEffects).toHaveLength(0);
    expect(costProvider.requests).toHaveLength(1);
    expect(costHarness.journal.snapshot().filter((event) => event.type === "approval.granted")).toHaveLength(0);
    expect(costHarness.journal.snapshot().filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
    const pauseTerminal = costHarness.journal.snapshot().find((event) =>
      event.type === "assistant.stream.completed" &&
      "stopReason" in event.payload && event.payload.stopReason === "tool_pause"
    );
    expect(pauseTerminal?.payload).toMatchObject({ costUnits: 3 });
    await costHarness.journal.close();
  });

  it("makes a human denial terminal in memory and after journal restart", async () => {
    const toolId = asId<ToolId>("tool.denied-write");
    const reviewed = reviewedFixtureTool({
      toolId,
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const manifest = reviewed.manifest;
    const provider = new ScriptedProvider("deny-terminal", [chunks(
      { kind: "delta", text: "nonterminal preface" },
      {
        kind: "tool_proposal",
        toolId,
        arguments: { text: "must remain denied" },
        summary: "Write a denied note",
      },
    )], undefined, undefined, [reviewed]);
    const effects: string[] = [];
    const { path, journal, coordinator } = await harness(
      [provider],
      (gateway) => gateway.registerTool({
        manifest,
        execute: async ({ idempotencyKey }) => {
          effects.push(idempotencyKey);
          return { output: null, outputSummary: "Unexpected effect." };
        },
      }),
      {
        costForProviderChunk: ({ chunkKind }) => chunkKind === "delta" ? 2 : chunkKind === "tool_proposal" ? 3 : 0,
      },
    );
    const originalInput = {
      workspaceId, conversationId, clientRequestId: "denied-turn", content: "Propose, then deny", user,
      proposingAgent: agent, provider: providerSelection("deny-terminal", ["streaming", "tool_proposals"]),
      budget: generousBudget, policyContext,
    };
    const paused = await coordinator.sendMessage(originalInput);
    if (paused.status !== "paused") throw new Error("Expected paused proposal");
    const denied = await coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "denied-turn-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "deny",
      approver: undefined,
      provider: providerSelection("deny-terminal", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
      signal: undefined,
    });
    const expectedDenied: TurnResult = {
      status: "denied",
      turnId: paused.turnId,
      reasonCode: "human_denied",
      steps: 2,
      costUnits: 5,
    };
    expect(denied).toEqual(expectedDenied);
    expect(await coordinator.sendMessage(originalInput)).toEqual(expectedDenied);
    expect(provider.requests).toHaveLength(1);
    expect(coordinator.cacheSizes().pendingProposals).toBe(0);
    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "denied-turn",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver,
      provider: providerSelection("deny-terminal", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
    })).rejects.toThrow("No live prepared effect");
    expect(effects).toHaveLength(0);

    const internals = coordinator as unknown as {
      completedRequests: Map<string, { readonly signature: string; readonly result: TurnResult }>;
      storeCompletedRequest(
        key: string,
        value: { readonly signature: string; readonly result: TurnResult },
      ): void;
    };
    const originalKey = JSON.stringify([workspaceId, conversationId, originalInput.clientRequestId]);
    for (let index = 0; index <= MAX_COORDINATOR_CACHE_ENTRIES; index += 1) {
      internals.storeCompletedRequest(`denied-eviction-${index}`, {
        signature: `denied-eviction-signature-${index}`,
        result: {
          status: "completed",
          turnId: asId<TurnId>(`denied-eviction-turn-${index}`),
          assistantText: `settled-${index}`,
          steps: 1,
          costUnits: 0,
        },
      });
    }
    expect(internals.completedRequests.has(originalKey)).toBe(false);
    expect(await coordinator.sendMessage(originalInput)).toEqual(expectedDenied);
    expect(provider.requests).toHaveLength(1);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const recoveredProvider = new ScriptedProvider(
      "deny-terminal",
      [chunks({ kind: "finish" })],
      undefined,
      undefined,
      [reviewed],
    );
    const recoveredRouter = new ProviderRouter();
    recoveredRouter.register(recoveredProvider);
    const recoveredGateway = new UniversalToolGateway(
      new ToolPolicy("policy-1"),
      reopened,
      undefined,
      reopened.snapshot(),
    );
    recoveredGateway.registerTool({
      manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "Unexpected effect." };
      },
    });
    const restarted = new RuntimeCoordinator(
      reopened,
      recoveredRouter,
      recoveredGateway,
      {
        costForProviderChunk: ({ chunkKind }) => chunkKind === "delta" ? 2 : chunkKind === "tool_proposal" ? 3 : 0,
      },
    );
    expect(await restarted.sendMessage(originalInput)).toEqual(expectedDenied);
    expect(recoveredProvider.requests).toHaveLength(0);
    const reconstructed = recoveredGateway.prepare({
      proposalId: paused.proposal.proposalId,
      workspaceId,
      conversationId,
      turnId: paused.turnId,
      actor: agent,
      toolId,
      arguments: { text: "must remain denied" },
      summary: "Write a denied note",
    });
    await expect(recoveredGateway.grantApproval(reconstructed, approver, policyContext)).rejects.toBeInstanceOf(
      ToolExecutionBlockedError,
    );
    await expect(recoveredGateway.executeDirect({ proposal: reconstructed, policyContext })).rejects.toMatchObject({
      reasonCode: "human_denied",
    });
    expect(effects).toHaveLength(0);
    await reopened.close();
  });

  it("replays durable approval.denied exactly when acknowledgement fails after sync", async () => {
    const toolId = asId<ToolId>("tool.denial-crash-boundary");
    const reviewed = reviewedFixtureTool({
      toolId,
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const directory = await temporary.directory();
    const path = join(directory, "denial-crash-boundary.journal");
    let injected = false;
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: (phase, events) => {
          if (!injected && phase === "after_sync_before_acknowledge" &&
            events.some((event) => event.type === "approval.denied")) {
            injected = true;
            throw new Error("fixture denial acknowledgement failure");
          }
        },
      },
    });
    const provider = new ScriptedProvider("denial-crash-boundary", [chunks({
      kind: "tool_proposal",
      toolId,
      arguments: { text: "deny durably" },
      summary: "Exercise denial crash boundary",
    })], undefined, undefined, [reviewed]);
    const router = new ProviderRouter();
    router.register(provider);
    const gateway = new UniversalToolGateway(new ToolPolicy("denial-crash-policy"), journal);
    gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async () => ({ output: null, outputSummary: "must not execute" }),
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Denial crash", user);
    await coordinator.createConversation(workspaceId, conversationId, "Denial crash", user);
    const originalInput = {
      workspaceId,
      conversationId,
      clientRequestId: "denial-crash-send",
      content: "prepare a durable denial",
      user,
      proposingAgent: agent,
      provider: providerSelection("denial-crash-boundary", ["streaming", "tool_proposals"]),
      budget: generousBudget,
      policyContext,
    };
    const paused = await coordinator.sendMessage(originalInput);
    if (paused.status !== "paused") throw new Error("Expected a paused denial boundary");
    const expected: TurnResult = {
      status: "denied",
      turnId: paused.turnId,
      reasonCode: "human_denied",
      steps: paused.steps,
      costUnits: paused.costUnits,
    };
    expect(await coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "denial-crash-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "deny",
      provider: originalInput.provider,
      budget: generousBudget,
      policyContext,
    })).toEqual(expected);
    expect(injected).toBe(true);
    expect(journal.snapshot().filter((event) => event.type === "approval.denied")).toHaveLength(1);
    expect(journal.snapshot().filter((event) =>
      event.type === "turn.completed" &&
      (event.payload as { status?: string }).status === "denied"
    )).toEqual([]);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const shouldNotRun = new ScriptedProvider(
      "denial-crash-boundary",
      [chunks({ kind: "finish" })],
      undefined,
      undefined,
      [reviewed],
    );
    const restartedRouter = new ProviderRouter();
    restartedRouter.register(shouldNotRun);
    const restarted = new RuntimeCoordinator(
      reopened,
      restartedRouter,
      new UniversalToolGateway(new ToolPolicy("denial-crash-policy"), reopened, undefined, reopened.snapshot()),
      zeroCostAccounting,
    );
    expect(await restarted.sendMessage(originalInput)).toEqual(expected);
    expect(shouldNotRun.requests).toEqual([]);
    await reopened.close();
  });

  it("keeps raw tool arguments and secret canaries out of durable audit and renderer-facing turn data", async () => {
    const secretCanary = "BOTBOTBOT_SECRET_CANARY_8f40f9";
    const reviewed = reviewedFixtureTool({
      toolId: asId<ToolId>("tool.write-note"),
      version: "1.0.0",
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    }, {
      type: "object",
      properties: { text: { type: "string" }, token: { type: "string" } },
      required: ["text", "token"],
      additionalProperties: false,
    });
    const provider = new ScriptedProvider("canary", [chunks({
      kind: "tool_proposal",
      toolId: asId<ToolId>("tool.write-note"),
      arguments: { text: "public summary", token: secretCanary },
      summary: "Write one note without exposing credentials",
    })], undefined, undefined, [reviewed]);
    const { path, journal, coordinator } = await harness([provider], (gateway) => gateway.registerTool({
      manifest: reviewed.manifest,
      execute: async () => ({ output: null, outputSummary: "Not expected to run." }),
    }));
    const result = await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "secret-canary", content: "Prepare a sensitive action", user,
      proposingAgent: agent, provider: providerSelection("canary", ["streaming", "tool_proposals"]),
      budget: generousBudget, policyContext,
    });
    expect(result.status).toBe("paused");
    expect(JSON.stringify(result)).not.toContain(secretCanary);
    if (result.status !== "paused") throw new Error("Expected paused turn");
    expect("arguments" in result.proposal).toBe(false);
    expect(await readFile(path, "utf8")).not.toContain(secretCanary);
    await journal.close();
  });

  it("rejects unavailable capabilities before user, provider, or tool activity", async () => {
    const provider = new ScriptedProvider("limited", [chunks({ kind: "finish" })], ["streaming"]);
    const { journal, coordinator } = await harness([provider]);
    const baseline = journal.snapshot().length;
    await expect(coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "bad-capability", content: "Use a tool", user, proposingAgent: agent,
      provider: providerSelection("limited", ["streaming", "tool_proposals"]), budget: generousBudget, policyContext,
    })).rejects.toThrow("Provider preflight failed");
    expect(provider.requests).toHaveLength(0);
    expect(journal.snapshot()).toHaveLength(baseline);
    await journal.close();
  });

  it("halts before recording a chunk that would exceed cost budget", async () => {
    const provider = new ScriptedProvider("costly", [chunks(
      { kind: "delta", text: "too expensive", costUnits: 2 },
      { kind: "finish" },
    )]);
    const { journal, coordinator } = await harness([provider], undefined, {
      costForProviderChunk: ({ chunkKind }) => chunkKind === "delta" ? 2 : 0,
    });
    const result = await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "budget", content: "Stay bounded", user, proposingAgent: agent,
      provider: providerSelection("costly"),
      budget: { maxSteps: 10, maxCostUnits: 1, maxDurationMs: 10_000 },
      policyContext,
    });
    expect(result).toMatchObject({ status: "failed", reasonCode: "cost_budget", costUnits: 0 });
    expect(journal.snapshot().filter((event) => event.type === "assistant.stream.advanced")).toHaveLength(0);
    await journal.close();
  });

  it("does not treat an arbitrary AbortError name as an authenticated cancellation", async () => {
    const canary = "RUNTIME_RAW_ABORT_NAME_CANARY_41dbe9";
    const provider = new ScriptedProvider("raw-abort-name", [chunks(
      { kind: "delta", text: "must not commit" },
      { kind: "finish" },
    )]);
    const { journal, coordinator } = await harness([provider], undefined, {
      costForProviderChunk: () => {
        const error = new Error(canary);
        error.name = "AbortError";
        (error as Error & { cause?: unknown }).cause = `${canary}-cause`;
        throw error;
      },
    });
    const result = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "raw-abort-name",
      content: "exercise raw abort name",
      user,
      proposingAgent: agent,
      provider: providerSelection("raw-abort-name"),
      budget: generousBudget,
      policyContext,
    });
    expect(result).toMatchObject({ status: "failed", reasonCode: "unknown_failure" });
    expect(JSON.stringify({ result, journal: journal.snapshot() })).not.toContain(canary);
    await journal.close();
  });

  it("preserves independent message, reaction, title, and agent-status mutations written concurrently", async () => {
    const provider = new ScriptedProvider("projection", [chunks({ kind: "delta", text: "message" }, { kind: "finish" })]);
    const { journal, coordinator } = await harness([provider]);
    await coordinator.sendMessage({
      workspaceId, conversationId, clientRequestId: "projection", content: "source", user, proposingAgent: agent,
      provider: providerSelection("projection"), budget: generousBudget, policyContext,
    });
    const messageId = projectConversation(journal.snapshot(), conversationId).normalizedHistory[0].id;
    const base = {
      workspaceId,
      conversationId,
      actor: user,
      timestamp: new Date().toISOString(),
      payloadSchemaVersion: 1 as const,
    };
    await Promise.all([
      journal.append({ ...base, eventId: asId<EventId>(randomUUID()), type: "conversation.title.changed", payload: { title: "Concurrent title" } }),
      journal.append({ ...base, eventId: asId<EventId>(randomUUID()), type: "message.reaction.changed", payload: { messageId: messageId as MessageId, reaction: "useful", enabled: true } }),
      journal.append({ ...base, eventId: asId<EventId>(randomUUID()), type: "agent.status.changed", payload: { agentId: agent.id, status: "ready" } }),
    ]);
    const projection = projectConversation(journal.snapshot(), conversationId);
    expect(projection.title).toBe("Concurrent title");
    expect(projection.reactions[messageId]).toEqual(["useful"]);
    expect(projection.agentStatuses[agent.id]).toBe("ready");
    await journal.close();
  });
});
