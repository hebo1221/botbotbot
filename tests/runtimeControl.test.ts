import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asId,
  type Actor,
  type ConversationId,
  type EventId,
  type MessageId,
  type ProviderId,
  type ProviderSelection,
  type ToolId,
  type ToolManifest,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import { canonicalHash, sha256Hex } from "../src/domain/canonical";
import { ToolPolicy } from "../src/policy/toolPolicy";
import { ProviderRouter } from "../src/providers/providerRouter";
import {
  RuntimeCoordinator,
  SendRequestConflictError,
  StaleTurnControlError,
  type FollowUpSteerInput,
  type SteerTurnInput,
  type StopTurnInput,
  type TurnResult,
} from "../src/runtime/runtimeCoordinator";
import { DurableJournal } from "../src/storage/durableJournal";
import { UniversalToolGateway } from "../src/tools/universalToolGateway";
import { ScriptedProvider, TempArea, chunks, zeroCostAccounting } from "./helpers";

const temporary = new TempArea();
const openJournals: DurableJournal[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openJournals.splice(0).map((journal) => journal.close().catch(() => undefined)));
  await temporary.cleanup();
});

const workspaceId = asId<WorkspaceId>("ws-runtime-control");
const conversationId = asId<ConversationId>("conv-runtime-control");
const human: Actor = { kind: "human", id: "human-control-owner" };
const agent: Actor = { kind: "agent", id: "agent-control-worker" };
const budget = { maxSteps: 50, maxCostUnits: 100, maxDurationMs: 10_000 };
const policyContext = { grantedDataScopes: [] as string[], grantedNetworkScopes: [] as string[] };

function selection(providerId: string): ProviderSelection {
  return {
    candidates: [{ providerId: asId<ProviderId>(providerId), modelId: "test-model" }],
    requiredCapabilities: ["streaming"],
  };
}

async function harness(
  provider: ScriptedProvider,
  registerTool?: (gateway: UniversalToolGateway) => void,
  costAccounting = zeroCostAccounting,
) {
  const directory = await temporary.directory();
  const path = `${directory}/runtime-control.journal`;
  const journal = await DurableJournal.open(path);
  openJournals.push(journal);
  const router = new ProviderRouter();
  router.register(provider);
  const gateway = new UniversalToolGateway(new ToolPolicy("policy-control"), journal, undefined, journal.snapshot());
  registerTool?.(gateway);
  const coordinator = new RuntimeCoordinator(journal, router, gateway, costAccounting);
  await coordinator.createWorkspace(workspaceId, "Runtime control", human);
  await coordinator.createConversation(workspaceId, conversationId, "Control timeline", human);
  return { path, journal, coordinator };
}

function activeTarget(journal: DurableJournal) {
  const accepted = journal.snapshot().find((event) => event.type === "user.message.accepted");
  if (!accepted) throw new Error("Expected a durable active turn");
  return {
    turnId: (accepted.payload as { turnId: TurnId }).turnId,
    directionEpoch: 1,
  };
}

describe("durable steering and stopping", () => {
  it("fsyncs stop before abort, terminalizes once, and drops output from an adapter that ignores abort", async () => {
    let journal!: DurableJournal;
    let ready!: () => void;
    const providerWaiting = new Promise<void>((resolve) => { ready = resolve; });
    let abortObservedDurableRequest = false;
    let abortCount = 0;
    const provider = new ScriptedProvider("stop-resistant", [async function* (request) {
      yield { kind: "delta", text: "partial-before-stop" } as const;
      ready();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => {
          abortCount += 1;
          abortObservedDurableRequest = journal.snapshot().some((event) => event.type === "human.control.requested");
          resolve();
        }, { once: true });
      });
      yield { kind: "delta", text: "late-must-not-commit" } as const;
      yield { kind: "finish" } as const;
    }]);
    const runtime = await harness(provider, undefined, {
      costForProviderChunk: ({ chunkKind }: { chunkKind: string }) => chunkKind === "delta" ? 4 : 0,
    });
    journal = runtime.journal;
    const send = runtime.coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "send-stop-target",
      content: "Work until stopped",
      user: human,
      proposingAgent: agent,
      provider: selection("stop-resistant"),
      budget,
      policyContext,
    });
    await providerWaiting;
    const target = activeTarget(journal);
    const control = {
      workspaceId,
      conversationId,
      clientRequestId: "durable-stop",
      ...target,
      human,
    };

    const stopped = await runtime.coordinator.stopTurn(control);
    expect(await send).toEqual(stopped);
    expect(stopped).toMatchObject({ status: "stopped", reasonCode: "human_stop", steps: 1, costUnits: 4 });
    expect(abortObservedDurableRequest).toBe(true);
    expect(abortCount).toBe(1);
    expect(journal.snapshot().filter((event) => event.type === "human.control.requested")).toHaveLength(1);
    expect(journal.snapshot().filter((event) => event.type === "turn.stopped")).toHaveLength(1);
    expect(JSON.stringify(journal.snapshot())).not.toContain("late-must-not-commit");

    expect(await runtime.coordinator.stopTurn(control)).toEqual(stopped);
    expect(await runtime.coordinator.stopTurn({
      ...control,
      human: { ...human, label: undefined },
    })).toEqual(stopped);
    expect(abortCount).toBe(1);
    await expect(runtime.coordinator.stopTurn({ ...control, clientRequestId: "stale-stop" })).rejects.toBeInstanceOf(
      StaleTurnControlError,
    );
    expect(journal.snapshot().filter((event) => event.type === "human.control.requested")).toHaveLength(1);

    await journal.close();
    openJournals.splice(openJournals.indexOf(journal), 1);
    const reopened = await DurableJournal.open(runtime.path);
    openJournals.push(reopened);
    const shouldNotRun = new ScriptedProvider("stop-resistant", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(shouldNotRun);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-control"), reopened, undefined, reopened.snapshot());
    const restarted = new RuntimeCoordinator(reopened, router, gateway, zeroCostAccounting);
    expect(await restarted.stopTurn(control)).toEqual(stopped);
    expect(shouldNotRun.requests).toHaveLength(0);
  });

  it("uses an immutable stop command and human identity while its journal write is blocked", async () => {
    const directory = await temporary.directory();
    const path = `${directory}/stop-command-snapshot.journal`;
    let reachedControl!: () => void;
    let releaseControl!: () => void;
    const controlBlocked = new Promise<void>((resolve) => { reachedControl = resolve; });
    const controlRelease = new Promise<void>((resolve) => { releaseControl = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) =>
            event.type === "human.control.requested" &&
            (event.payload as { clientRequestId?: string }).clientRequestId === "stop-snapshot-command"
          )) {
            reachedControl();
            await controlRelease;
          }
        },
      },
    });
    openJournals.push(journal);
    let providerReady!: () => void;
    const ready = new Promise<void>((resolve) => { providerReady = resolve; });
    const provider = new ScriptedProvider("stop-command-snapshot", [async function* (request) {
      yield { kind: "delta", text: "committed before stop" } as const;
      providerReady();
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    }]);
    const router = new ProviderRouter();
    router.register(provider);
    const coordinator = new RuntimeCoordinator(
      journal,
      router,
      new UniversalToolGateway(new ToolPolicy("stop-command-snapshot-policy"), journal),
      zeroCostAccounting,
    );
    await coordinator.createWorkspace(workspaceId, "Stop snapshot", human);
    await coordinator.createConversation(workspaceId, conversationId, "Stop snapshot", human);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "stop-command-snapshot-send",
      content: "Wait for a captured stop",
      user: human,
      proposingAgent: agent,
      provider: selection("stop-command-snapshot"),
      budget,
      policyContext,
    });
    await ready;
    const target = activeTarget(journal);
    const mutableHuman = { kind: "human", id: "human-stop-original", label: "Original controller" };
    const mutableControl = {
      workspaceId: String(workspaceId),
      conversationId: String(conversationId),
      clientRequestId: "stop-snapshot-command",
      turnId: String(target.turnId),
      directionEpoch: 1,
      human: mutableHuman,
    };
    const operation = coordinator.stopTurn(mutableControl as unknown as StopTurnInput);
    await controlBlocked;
    mutableControl.workspaceId = "ws-mutated";
    mutableControl.conversationId = "conversation-mutated";
    mutableControl.clientRequestId = "stop-mutated";
    mutableControl.turnId = "turn-mutated";
    mutableControl.directionEpoch = 99;
    mutableHuman.kind = "agent";
    mutableHuman.id = "human-mutated";
    mutableHuman.label = "Mutated controller";
    releaseControl();

    const stopped = await operation;
    expect(await send).toEqual(stopped);
    expect(stopped).toMatchObject({ status: "stopped", turnId: target.turnId, reasonCode: "human_stop" });
    const requested = journal.snapshot().find((event) => event.type === "human.control.requested");
    expect(requested).toMatchObject({
      workspaceId,
      conversationId,
      actor: { kind: "human", id: "human-stop-original", label: "Original controller" },
      payload: {
        clientRequestId: "stop-snapshot-command",
        turnId: target.turnId,
        directionEpoch: 1,
      },
    });
    expect(journal.snapshot().find((event) => event.type === "turn.stopped")?.payload).toMatchObject({
      clientRequestId: "stop-snapshot-command",
      turnId: target.turnId,
      directionEpoch: 1,
    });
  });

  it("steers one turn into the next epoch exactly once with complete committed history", async () => {
    let ready!: () => void;
    const providerWaiting = new Promise<void>((resolve) => { ready = resolve; });
    const provider = new ScriptedProvider("steerable", [
      async function* (request) {
        yield { kind: "delta", text: "discarded partial" } as const;
        ready();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        yield { kind: "delta", text: "late old epoch" } as const;
      },
      chunks({ kind: "delta", text: "answer after steering" }, { kind: "finish" }),
    ]);
    const { journal, coordinator } = await harness(provider);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "send-steer-target",
      content: "Initial direction",
      user: human,
      proposingAgent: agent,
      provider: selection("steerable"),
      budget,
      policyContext,
    });
    await providerWaiting;
    const target = activeTarget(journal);
    const steer = {
      workspaceId,
      conversationId,
      clientRequestId: "steer-once",
      ...target,
      human,
      content: "Use the revised direction",
    };

    const steered = await coordinator.steerTurn(steer);
    expect(await send).toEqual(steered);
    expect(steered).toMatchObject({ status: "completed", assistantText: "answer after steering" });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].directionEpoch).toBe(1);
    expect(provider.requests[1].directionEpoch).toBe(2);
    expect(provider.requests[1].turnId).toBe(target.turnId);
    expect(provider.requests[1].history.map((message) => message.kind === "text" ? message.text : "tool")).toEqual([
      "Initial direction",
      "Use the revised direction",
    ]);
    expect(JSON.stringify(journal.snapshot())).not.toContain("late old epoch");
    expect(journal.snapshot().filter((event) => event.type === "human.control.requested")).toHaveLength(1);
    expect(journal.snapshot().filter((event) => event.type === "turn.steered")).toHaveLength(1);
    expect(journal.snapshot().filter((event) =>
      event.type === "direction.accepted" &&
      (event.payload as { directionEpoch: number }).directionEpoch === 2
    )).toHaveLength(1);

    expect(await coordinator.steerTurn(steer)).toEqual(steered);
    expect(await coordinator.steerTurn({
      ...steer,
      human: { ...human, label: undefined },
    })).toEqual(steered);
    expect(provider.requests).toHaveLength(2);
  });

  it("uses an immutable steer command and content while its journal batch is blocked", async () => {
    const directory = await temporary.directory();
    const path = `${directory}/steer-command-snapshot.journal`;
    let reachedControl!: () => void;
    let releaseControl!: () => void;
    const controlBlocked = new Promise<void>((resolve) => { reachedControl = resolve; });
    const controlRelease = new Promise<void>((resolve) => { releaseControl = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) =>
            event.type === "human.control.requested" &&
            (event.payload as { clientRequestId?: string }).clientRequestId === "steer-snapshot-command"
          )) {
            reachedControl();
            await controlRelease;
          }
        },
      },
    });
    openJournals.push(journal);
    let providerReady!: () => void;
    const ready = new Promise<void>((resolve) => { providerReady = resolve; });
    const provider = new ScriptedProvider("steer-command-snapshot", [
      async function* (request) {
        providerReady();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      chunks({ kind: "delta", text: "captured steer" }, { kind: "finish" }),
    ]);
    const router = new ProviderRouter();
    router.register(provider);
    const coordinator = new RuntimeCoordinator(
      journal,
      router,
      new UniversalToolGateway(new ToolPolicy("steer-command-snapshot-policy"), journal),
      zeroCostAccounting,
    );
    await coordinator.createWorkspace(workspaceId, "Steer snapshot", human);
    await coordinator.createConversation(workspaceId, conversationId, "Steer snapshot", human);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "steer-command-snapshot-send",
      content: "Initial captured direction",
      user: human,
      proposingAgent: agent,
      provider: selection("steer-command-snapshot"),
      budget,
      policyContext,
    });
    await ready;
    const target = activeTarget(journal);
    const mutableHuman = { kind: "human", id: "human-steer-original", label: "Original steerer" };
    const mutableControl = {
      workspaceId: String(workspaceId),
      conversationId: String(conversationId),
      clientRequestId: "steer-snapshot-command",
      turnId: String(target.turnId),
      directionEpoch: 1,
      human: mutableHuman,
      content: "Original revised direction",
    };
    const operation = coordinator.steerTurn(mutableControl as unknown as SteerTurnInput);
    await controlBlocked;
    mutableControl.workspaceId = "ws-mutated";
    mutableControl.conversationId = "conversation-mutated";
    mutableControl.clientRequestId = "steer-mutated";
    mutableControl.turnId = "turn-mutated";
    mutableControl.directionEpoch = 99;
    mutableControl.content = "Mutated direction";
    mutableHuman.kind = "agent";
    mutableHuman.id = "human-mutated";
    mutableHuman.label = "Mutated steerer";
    releaseControl();

    const steered = await operation;
    expect(await send).toEqual(steered);
    expect(steered).toMatchObject({ status: "completed", assistantText: "captured steer" });
    const requested = journal.snapshot().find((event) => event.type === "human.control.requested");
    expect(requested).toMatchObject({
      workspaceId,
      conversationId,
      actor: { kind: "human", id: "human-steer-original", label: "Original steerer" },
      payload: { clientRequestId: "steer-snapshot-command", turnId: target.turnId, directionEpoch: 1 },
    });
    const steeredMessage = journal.snapshot().find((event) =>
      event.type === "user.message.accepted" &&
      (event.payload as { clientRequestId?: string }).clientRequestId === "steer-snapshot-command"
    );
    expect(steeredMessage).toMatchObject({
      actor: { kind: "human", id: "human-steer-original", label: "Original steerer" },
      payload: { content: "Original revised direction" },
    });
    expect(provider.requests[1].history.map((record) => record.kind === "text" ? record.text : "tool"))
      .toEqual(["Initial captured direction", "Original revised direction"]);
  });

  it("replays a denied terminal instead of a stale paused steer result", async () => {
    const toolId = asId<ToolId>("tool.steer-paused-denied");
    const inputSchema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    } as const;
    const manifest: ToolManifest = {
      toolId,
      version: "1.0.0",
      schemaHash: canonicalHash(inputSchema),
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    };
    const reviewedTool = {
      toolId,
      wireName: "steer_paused_denied",
      description: "Reviewed steer pause fixture.",
      inputSchema,
      schemaHash: manifest.schemaHash,
      manifest,
    } as const;
    let ready!: () => void;
    const providerWaiting = new Promise<void>((resolve) => { ready = resolve; });
    const provider = new ScriptedProvider("steer-paused-denied", [
      async function* (request) {
        yield { kind: "delta", text: "retired partial" } as const;
        ready();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      chunks({
        kind: "tool_proposal",
        toolId,
        arguments: { note: "must remain denied" },
        summary: "Pause the steered phase",
      }),
    ], undefined, undefined, [reviewedTool]);
    const effects: string[] = [];
    const { path, journal, coordinator } = await harness(provider, (gateway) => gateway.registerTool({
      manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "unexpected effect" };
      },
    }));
    const toolSelection: ProviderSelection = {
      ...selection("steer-paused-denied"),
      requiredCapabilities: ["streaming", "tool_proposals"],
    };
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "steer-paused-denied-send",
      content: "start the first epoch",
      user: human,
      proposingAgent: agent,
      provider: toolSelection,
      budget,
      policyContext,
    });
    await providerWaiting;
    const steer = {
      workspaceId,
      conversationId,
      clientRequestId: "steer-paused-denied-control",
      ...activeTarget(journal),
      human,
      content: "pause on a reviewed tool",
    };
    const paused = await coordinator.steerTurn(steer);
    expect(await send).toEqual(paused);
    if (paused.status !== "paused") throw new Error("Expected the steered phase to pause");

    const denied = await coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "steer-paused-denied-decision",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "deny",
      provider: toolSelection,
      budget,
      policyContext,
    });
    expect(denied).toMatchObject({ status: "denied" });
    const cache = coordinator as unknown as {
      completedControlOperations: Map<string, { readonly signature: string; readonly result: TurnResult }>;
      storeCompletedControlOperation(
        key: string,
        value: { readonly signature: string; readonly result: TurnResult },
      ): void;
    };
    for (let index = 0; index <= 1_024; index += 1) {
      cache.storeCompletedControlOperation(`settled-control-${index}`, {
        signature: `settled-control-signature-${index}`,
        result: {
          status: "completed",
          turnId: asId<TurnId>(`settled-control-turn-${index}`),
          assistantText: `settled-${index}`,
          steps: 1,
          costUnits: 0,
        },
      });
    }
    expect(await coordinator.steerTurn(steer)).toMatchObject({
      status: "denied",
      reasonCode: "human_denied",
    });
    expect(effects).toHaveLength(0);
    expect(provider.requests).toHaveLength(2);

    await journal.close();
    openJournals.splice(openJournals.indexOf(journal), 1);
    const reopened = await DurableJournal.open(path);
    openJournals.push(reopened);
    const shouldNotRun = new ScriptedProvider(
      "steer-paused-denied",
      [chunks({ kind: "finish" })],
      undefined,
      undefined,
      [reviewedTool],
    );
    const router = new ProviderRouter();
    router.register(shouldNotRun);
    const restarted = new RuntimeCoordinator(
      reopened,
      router,
      new UniversalToolGateway(new ToolPolicy("policy-control"), reopened, undefined, reopened.snapshot()),
      zeroCostAccounting,
    );
    expect(await restarted.steerTurn(steer)).toEqual(denied);
    expect(shouldNotRun.requests).toHaveLength(0);
  });

  it("rejects stop and steer that reuse the active send request ID without aborting the send", async () => {
    let ready!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    const continueProvider = new Promise<void>((resolve) => { release = resolve; });
    let abortCount = 0;
    const provider = new ScriptedProvider("collision-live", [async function* (request) {
      yield { kind: "delta", text: "still running" } as const;
      ready();
      request.signal.addEventListener("abort", () => { abortCount += 1; }, { once: true });
      await continueProvider;
      yield { kind: "delta", text: " and completed" } as const;
      yield { kind: "finish" } as const;
    }]);
    const { journal, coordinator } = await harness(provider);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "shared-active-key",
      content: "Keep this request alive",
      user: human,
      proposingAgent: agent,
      provider: selection("collision-live"),
      budget,
      policyContext,
    });
    await waiting;
    const target = activeTarget(journal);
    await expect(coordinator.stopTurn({
      workspaceId,
      conversationId,
      clientRequestId: "shared-active-key",
      ...target,
      human,
    })).rejects.toBeInstanceOf(StaleTurnControlError);
    await expect(coordinator.steerTurn({
      workspaceId,
      conversationId,
      clientRequestId: "shared-active-key",
      ...target,
      human,
      content: "Conflicting steer",
    })).rejects.toBeInstanceOf(StaleTurnControlError);
    expect(abortCount).toBe(0);
    expect(journal.snapshot().some((event) => event.type === "human.control.requested")).toBe(false);

    release();
    expect(await send).toMatchObject({ status: "completed", assistantText: "still running and completed" });
    expect(abortCount).toBe(0);
  });

  it("keeps epoch two running when stale controls target retired epoch one", async () => {
    let firstReady!: () => void;
    let secondReady!: () => void;
    let releaseSecond!: () => void;
    const firstWaiting = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondWaiting = new Promise<void>((resolve) => { secondReady = resolve; });
    const continueSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondAbortCount = 0;
    const provider = new ScriptedProvider("epoch-race", [
      async function* (request) {
        yield { kind: "delta", text: "old partial" } as const;
        firstReady();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      async function* (request) {
        yield { kind: "delta", text: "epoch two" } as const;
        secondReady();
        request.signal.addEventListener("abort", () => { secondAbortCount += 1; }, { once: true });
        await continueSecond;
        yield { kind: "delta", text: " completed" } as const;
        yield { kind: "finish" } as const;
      },
    ]);
    const { journal, coordinator } = await harness(provider);
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "epoch-race-send",
      content: "Start epoch one",
      user: human,
      proposingAgent: agent,
      provider: selection("epoch-race"),
      budget,
      policyContext,
    });
    await firstWaiting;
    const target = activeTarget(journal);
    const steering = coordinator.steerTurn({
      workspaceId,
      conversationId,
      clientRequestId: "epoch-race-steer",
      ...target,
      human,
      content: "Start epoch two",
    });
    await secondWaiting;
    const eventCount = journal.snapshot().length;
    await expect(coordinator.stopTurn({
      workspaceId,
      conversationId,
      clientRequestId: "stale-epoch-one-stop",
      ...target,
      human,
    })).rejects.toBeInstanceOf(StaleTurnControlError);
    await expect(coordinator.steerTurn({
      workspaceId,
      conversationId,
      clientRequestId: "stale-epoch-one-steer",
      ...target,
      human,
      content: "Must not replace epoch two",
    })).rejects.toBeInstanceOf(StaleTurnControlError);
    expect(journal.snapshot()).toHaveLength(eventCount);
    expect(secondAbortCount).toBe(0);

    releaseSecond();
    expect(await steering).toMatchObject({ status: "completed", assistantText: "epoch two completed" });
    expect(await send).toMatchObject({ status: "completed", assistantText: "epoch two completed" });
    expect(secondAbortCount).toBe(0);
    expect(provider.requests).toHaveLength(2);
  });

  it("returns an explicit interrupted result for a persisted control request after restart", async () => {
    const provider = new ScriptedProvider("must-not-dispatch", [chunks({ kind: "finish" })]);
    const { path, journal } = await harness(provider);
    const turnId = asId<TurnId>("turn-persisted-control");
    const messageId = asId<MessageId>("message-persisted-control");
    const acceptedAt = "2026-08-26T01:02:03.000Z";
    const controlId = "control-persisted-without-terminal";
    await journal.appendBatch([
      {
        eventId: asId<EventId>("event-persisted-message"), workspaceId, conversationId, actor: human,
        timestamp: acceptedAt, payloadSchemaVersion: 1, type: "user.message.accepted",
        payload: { messageId, turnId, clientRequestId: "persisted-send", content: "Persist first" },
      },
      {
        eventId: asId<EventId>("event-persisted-direction"), workspaceId, conversationId, actor: human,
        timestamp: acceptedAt, payloadSchemaVersion: 1, type: "direction.accepted",
        payload: {
          directionId: "direction-persisted", turnId, clientRequestId: "persisted-send", directionEpoch: 1,
          kind: "initial", messageId, contentHash: sha256Hex("Persist first"), acceptedAt,
        },
      },
      {
        eventId: asId<EventId>("event-persisted-control"), workspaceId, conversationId, actor: human,
        timestamp: acceptedAt, payloadSchemaVersion: 1, type: "human.control.requested",
        payload: {
          controlId, controlKind: "stop", turnId, clientRequestId: "persisted-stop", directionEpoch: 1,
          directionHash: sha256Hex("stop"), requestedAt: acceptedAt,
        },
      },
    ]);
    await journal.close();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const reopened = await DurableJournal.open(path);
    openJournals.push(reopened);
    const router = new ProviderRouter();
    router.register(provider);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-control"), reopened, undefined, reopened.snapshot());
    const restarted = new RuntimeCoordinator(reopened, router, gateway, zeroCostAccounting);
    expect(await restarted.stopTurn({
      workspaceId,
      conversationId,
      turnId,
      directionEpoch: 1,
      clientRequestId: "persisted-stop",
      human,
    })).toMatchObject({
      status: "interrupted",
      reasonCode: "interrupted_stop_requires_reconciliation",
    });
    expect(provider.requests).toHaveLength(0);
    expect(reopened.snapshot().filter((event) => event.type === "human.control.requested")).toHaveLength(1);
  });

  it("rejects changed send payloads and send/control client-ID collisions without a write or provider call", async () => {
    const provider = new ScriptedProvider("signature", [chunks(
      { kind: "delta", text: "signed result" },
      { kind: "finish" },
    )]);
    const { path, journal, coordinator } = await harness(provider);
    const base = {
      workspaceId,
      conversationId,
      clientRequestId: "signature-key",
      content: "Original signed request",
      user: human,
      proposingAgent: agent,
      provider: selection("signature"),
      budget,
      policyContext,
    };
    const completed = await coordinator.sendMessage(base);
    const eventCount = journal.snapshot().length;
    await expect(coordinator.sendMessage({ ...base, content: "Changed request" })).rejects.toBeInstanceOf(
      SendRequestConflictError,
    );
    await expect(coordinator.stopTurn({
      workspaceId,
      conversationId,
      turnId: completed.turnId,
      directionEpoch: 1,
      clientRequestId: "signature-key",
      human,
    })).rejects.toBeInstanceOf(StaleTurnControlError);
    expect(provider.requests).toHaveLength(1);
    expect(journal.snapshot()).toHaveLength(eventCount);

    await journal.close();
    openJournals.splice(openJournals.indexOf(journal), 1);
    const reopened = await DurableJournal.open(path);
    openJournals.push(reopened);
    const shouldNotRun = new ScriptedProvider("signature", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(shouldNotRun);
    const gateway = new UniversalToolGateway(new ToolPolicy("policy-control"), reopened, undefined, reopened.snapshot());
    const restarted = new RuntimeCoordinator(reopened, router, gateway, zeroCostAccounting);
    await expect(restarted.sendMessage({ ...base, content: "Changed after restart" })).rejects.toBeInstanceOf(
      SendRequestConflictError,
    );
    expect(await restarted.sendMessage(base)).toMatchObject({ status: "completed", assistantText: "signed result" });
    expect(shouldNotRun.requests).toHaveLength(0);
    expect(reopened.snapshot()).toHaveLength(eventCount);
  });

  it("rejects an approval prepared by a retired direction epoch before any tool effect", async () => {
    const toolId = asId<ToolId>("tool.retired-epoch");
    const inputSchema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    } as const;
    const manifest: ToolManifest = {
      toolId,
      version: "1.0.0",
      schemaHash: canonicalHash(inputSchema),
      effect: "write",
      dataScope: ["workspace/notes"],
      networkScope: [],
      idempotency: "non_idempotent",
    };
    const reviewedTool = {
      toolId,
      wireName: "retired_epoch",
      description: "Reviewed retired-epoch fixture.",
      inputSchema,
      schemaHash: manifest.schemaHash,
      manifest,
    } as const;
    const provider = new ScriptedProvider("epoch-tool", [chunks({
      kind: "tool_proposal",
      toolId,
      arguments: { note: "must not execute" },
      summary: "Write after approval",
    })], undefined, undefined, [reviewedTool]);
    const effects: string[] = [];
    const { journal, coordinator } = await harness(provider, (gateway) => gateway.registerTool({
      manifest,
      execute: async ({ idempotencyKey }) => {
        effects.push(idempotencyKey);
        return { output: null, outputSummary: "Unexpected effect" };
      },
    }));
    const paused = await coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "epoch-tool-send",
      content: "Prepare a tool",
      user: human,
      proposingAgent: agent,
      provider: { ...selection("epoch-tool"), requiredCapabilities: ["streaming", "tool_proposals"] },
      budget,
      policyContext,
    });
    if (paused.status !== "paused") throw new Error("Expected a paused proposal");
    expect(paused.proposal.directionEpoch).toBe(1);

    const at = "2026-08-26T02:03:04.000Z";
    const messageId = asId<MessageId>("message-retiring-tool-epoch");
    await journal.appendBatch([
      {
        eventId: asId<EventId>("event-retiring-tool-control"), workspaceId, conversationId, actor: human,
        timestamp: at, payloadSchemaVersion: 1, type: "human.control.requested",
        payload: {
          controlId: "control-retiring-tool", controlKind: "steer", turnId: paused.turnId,
          clientRequestId: "retire-tool-epoch", directionEpoch: 1,
          directionHash: sha256Hex("New direction"), requestedAt: at,
        },
      },
      {
        eventId: asId<EventId>("event-retiring-tool-message"), workspaceId, conversationId, actor: human,
        timestamp: at, payloadSchemaVersion: 1, type: "user.message.accepted",
        payload: { messageId, turnId: paused.turnId, clientRequestId: "retire-tool-epoch", content: "New direction" },
      },
      {
        eventId: asId<EventId>("event-retiring-tool-direction"), workspaceId, conversationId, actor: human,
        timestamp: at, payloadSchemaVersion: 1, type: "direction.accepted",
        payload: {
          directionId: "direction-retiring-tool", turnId: paused.turnId,
          clientRequestId: "retire-tool-epoch", directionEpoch: 2, kind: "steer", messageId,
          contentHash: sha256Hex("New direction"), acceptedAt: at,
        },
      },
      {
        eventId: asId<EventId>("event-retiring-tool-terminal"), workspaceId, conversationId,
        actor: { kind: "system", id: "runtime-coordinator" }, timestamp: at, payloadSchemaVersion: 1,
        type: "turn.steered",
        payload: {
          controlId: "control-retiring-tool", turnId: paused.turnId,
          clientRequestId: "retire-tool-epoch", retiredDirectionEpoch: 1, nextDirectionEpoch: 2,
          directionId: "direction-retiring-tool", steeredAt: at,
        },
      },
    ]);

    await expect(coordinator.decideProposal({
      workspaceId,
      conversationId,
      clientRequestId: "epoch-tool-send",
      turnId: paused.turnId,
      proposalId: paused.proposal.proposalId,
      disposition: "approve",
      approver: {
        principalId: human.id,
        kind: "human",
        assurance: "authenticated_control_plane",
      },
      provider: { ...selection("epoch-tool"), requiredCapabilities: ["streaming", "tool_proposals"] },
      budget,
      policyContext,
    })).rejects.toBeInstanceOf(StaleTurnControlError);
    expect(effects).toHaveLength(0);
    expect(journal.snapshot().some((event) => event.type === "tool.execution.started")).toBe(false);
  });

  it("turns targetless steer into one idempotent normal follow-up when no turn is active", async () => {
    const provider = new ScriptedProvider("follow-up", [chunks(
      { kind: "delta", text: "follow-up answer" },
      { kind: "finish" },
    )]);
    const { journal, coordinator } = await harness(provider);
    const followUp = {
      workspaceId,
      conversationId,
      clientRequestId: "follow-up-steer",
      content: "Continue from here",
      human,
      proposingAgent: agent,
      provider: selection("follow-up"),
      budget,
      policyContext,
    };
    const baseline = journal.snapshot().length;
    await expect(coordinator.steerTurn({ ...followUp, clientRequestId: "empty-follow-up", content: "   " })).rejects.toThrow(
      "between 1 and 8000",
    );
    await expect(coordinator.steerTurn({
      ...followUp,
      clientRequestId: "oversized-follow-up",
      content: "x".repeat(8_001),
    })).rejects.toThrow("between 1 and 8000");
    expect(journal.snapshot()).toHaveLength(baseline);
    expect(provider.requests).toHaveLength(0);
    const first = await coordinator.steerTurn(followUp);
    expect(first).toMatchObject({ status: "completed", assistantText: "follow-up answer" });
    expect(await coordinator.steerTurn(followUp)).toEqual(first);
    expect(await coordinator.steerTurn({
      ...followUp,
      human: { ...human, label: undefined },
      proposingAgent: { ...agent, label: undefined },
      signal: undefined,
      turnId: undefined,
      directionEpoch: undefined,
    })).toEqual(first);
    expect(provider.requests).toHaveLength(1);
    expect(journal.snapshot().filter((event) => event.type === "user.message.accepted")).toHaveLength(1);
    expect(journal.snapshot().some((event) =>
      event.type === "direction.accepted" &&
      (event.payload as { kind: string }).kind === "follow_up"
    )).toBe(true);
  });

  it("admits an immutable follow-up steer snapshot before its first journal write", async () => {
    const toolId = asId<ToolId>("tool.follow-up-command-snapshot");
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    } as const;
    const manifest: ToolManifest = {
      toolId,
      version: "1.0.0",
      schemaHash: canonicalHash(inputSchema),
      effect: "external_read",
      dataScope: ["workspace/original"],
      networkScope: ["https://original.example"],
      idempotency: "idempotent",
    };
    const reviewed = {
      toolId,
      wireName: "follow_up_command_snapshot",
      description: "Reviewed follow-up snapshot fixture.",
      inputSchema,
      schemaHash: manifest.schemaHash,
      manifest,
    } as const;
    const directory = await temporary.directory();
    const path = `${directory}/follow-up-command-snapshot.journal`;
    let reached!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const journal = await DurableJournal.open(path, {
      faultInjector: {
        reach: async (phase, events) => {
          if (phase === "before_write" && events.some((event) =>
            event.type === "user.message.accepted" &&
            (event.payload as { clientRequestId?: string }).clientRequestId === "follow-up-snapshot"
          )) {
            reached();
            await resume;
          }
        },
      },
    });
    openJournals.push(journal);
    const chosen = new ScriptedProvider("follow-up-snapshot", [chunks({
      kind: "tool_proposal",
      toolId,
      arguments: { query: "captured" },
      summary: "Use captured follow-up authority",
    })], undefined, undefined, [reviewed]);
    const decoy = new ScriptedProvider("follow-up-snapshot-decoy", [chunks({ kind: "finish" })]);
    const router = new ProviderRouter();
    router.register(chosen);
    router.register(decoy);
    const gateway = new UniversalToolGateway(new ToolPolicy("follow-up-snapshot-policy"), journal);
    gateway.registerTool({
      manifest,
      execute: async () => ({ output: null, outputSummary: "not executed" }),
    });
    const coordinator = new RuntimeCoordinator(journal, router, gateway, zeroCostAccounting);
    await coordinator.createWorkspace(workspaceId, "Follow-up snapshot", human);
    await coordinator.createConversation(workspaceId, conversationId, "Follow-up snapshot", human);

    const mutableHuman = { kind: "human", id: "human-follow-up-original", label: "Original follow-up human" };
    const mutableAgent = { kind: "agent", id: "agent-follow-up-original", label: "Original follow-up agent" };
    const mutableProvider = {
      candidates: [{ providerId: "follow-up-snapshot", modelId: "test-model" }],
      requiredCapabilities: ["streaming", "tool_proposals"],
    };
    const mutableBudget = { maxSteps: 8, maxCostUnits: 10, maxDurationMs: 10_000 };
    const mutablePolicy = {
      grantedDataScopes: ["workspace/original"],
      grantedNetworkScopes: ["https://original.example"],
    };
    const mutableFollowUp = {
      workspaceId: String(workspaceId),
      conversationId: String(conversationId),
      clientRequestId: "follow-up-snapshot",
      content: "Original follow-up content",
      human: mutableHuman,
      proposingAgent: mutableAgent,
      provider: mutableProvider,
      budget: mutableBudget,
      policyContext: mutablePolicy,
      signal: new AbortController().signal,
    };
    const operation = coordinator.steerTurn(mutableFollowUp as unknown as FollowUpSteerInput);
    await blocked;
    mutableFollowUp.workspaceId = "ws-mutated";
    mutableFollowUp.conversationId = "conversation-mutated";
    mutableFollowUp.clientRequestId = "follow-up-mutated";
    mutableFollowUp.content = "Mutated follow-up";
    mutableHuman.kind = "agent";
    mutableHuman.id = "human-mutated";
    mutableHuman.label = "Mutated human";
    mutableAgent.kind = "human";
    mutableAgent.id = "agent-mutated";
    mutableAgent.label = "Mutated agent";
    mutableProvider.candidates[0].providerId = "follow-up-snapshot-decoy";
    mutableProvider.candidates[0].modelId = "mutated-model";
    mutableProvider.requiredCapabilities.splice(0, mutableProvider.requiredCapabilities.length, "image_input");
    mutableBudget.maxSteps = 0;
    mutableBudget.maxCostUnits = -1;
    mutableBudget.maxDurationMs = -1;
    mutablePolicy.grantedDataScopes.splice(0, 1, "workspace/mutated");
    mutablePolicy.grantedNetworkScopes.splice(0, 1, "https://mutated.example");
    mutableFollowUp.signal = AbortSignal.abort();
    release();

    const paused = await operation;
    expect(paused).toMatchObject({
      status: "paused",
      decision: { reasonCode: "provider_proposal_requires_exact_grant" },
      proposal: { actor: { kind: "agent", id: "agent-follow-up-original", label: "Original follow-up agent" } },
    });
    expect(chosen.requests).toHaveLength(1);
    expect(decoy.requests).toHaveLength(0);
    expect(journal.snapshot().find((event) => event.type === "user.message.accepted")).toMatchObject({
      workspaceId,
      conversationId,
      actor: { kind: "human", id: "human-follow-up-original", label: "Original follow-up human" },
      payload: { clientRequestId: "follow-up-snapshot", content: "Original follow-up content" },
    });
  });

  it("cleans retired and completed controller timers and external abort listeners", async () => {
    let firstReady!: () => void;
    const waiting = new Promise<void>((resolve) => { firstReady = resolve; });
    const provider = new ScriptedProvider("controller-cleanup", [
      async function* (request) {
        yield { kind: "delta", text: "old phase" } as const;
        firstReady();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      chunks({ kind: "delta", text: "new phase complete" }, { kind: "finish" }),
    ]);
    const { journal, coordinator } = await harness(provider);
    const external = new AbortController().signal;
    vi.useFakeTimers();
    const send = coordinator.sendMessage({
      workspaceId,
      conversationId,
      clientRequestId: "controller-cleanup-send",
      content: "Start and steer",
      user: human,
      proposingAgent: agent,
      provider: selection("controller-cleanup"),
      budget,
      policyContext,
      signal: external,
    });
    await waiting;
    const result = await coordinator.steerTurn({
      workspaceId,
      conversationId,
      clientRequestId: "controller-cleanup-steer",
      ...activeTarget(journal),
      human,
      content: "Use the clean phase",
    });
    expect(await send).toEqual(result);
    expect(result).toMatchObject({ status: "completed", assistantText: "new phase complete" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
