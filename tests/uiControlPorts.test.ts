import { describe, expect, it } from "vitest";
import {
  executeTurnControlMutation,
  executeWorkspaceControlMutation,
  validateRefreshedControlRoom,
  validateTurnControlReceipt,
  validateWorkspaceControlReceipt,
  type ControlRoomViewPort,
  type DurableTurnControlReceipt,
  type DurableWorkspaceControlReceipt,
  type TurnControlPort,
  type TurnControlRequest,
  type WorkspaceControlPort,
  type WorkspaceControlRequest,
} from "../src/application/workspaceControlPorts";
import { demoModel } from "../src/ui/App";

const base = {
  workspaceId: "workspace-botbotbot-lab",
  humanActorId: "human-owner",
  clientRequestId: "client-1",
} as const;

const workspaceRequests: readonly WorkspaceControlRequest[] = [
  {
    ...base,
    action: "agent.create",
    agentId: "agent-new",
    displayName: "파동",
    roleTitle: "조사원",
    colorToken: "relay-cobalt",
    markToken: "signal",
    status: "idle",
  },
  {
    ...base,
    action: "agent.update",
    agentId: "agent-yoonseul",
    expectedRevision: 4,
    displayName: "윤슬",
    roleTitle: "메모리 감사",
    colorToken: "warm-coral",
    markToken: "orbit",
    status: "waiting_for_human",
  },
  { ...base, action: "section.create", sectionId: "section-new", name: "새 섹션", orderKey: 300 },
  { ...base, action: "section.rename", sectionId: "section-research", expectedRevision: 3, name: "실험" },
  { ...base, action: "section.reorder", sectionId: "section-research", expectedRevision: 3, orderKey: 250 },
  {
    ...base,
    action: "section.assign_agent",
    agentId: "agent-yoonseul",
    expectedMembershipRevision: 1,
    sectionId: "section-release",
  },
  { ...base, action: "section.delete", sectionId: "section-release", expectedRevision: 2 },
  {
    ...base,
    action: "reaction.set",
    conversationId: "conv-memory-audit",
    messageId: "message-1",
    reactionToken: "useful",
    present: true,
  },
] as const;

function workspaceReceipt(
  request: WorkspaceControlRequest,
  globalSequence = 190,
): DurableWorkspaceControlReceipt {
  return { receiptKind: "durable_workspace_control_event", request, globalSequence };
}

function turnReceipt(
  request: TurnControlRequest,
  globalSequence = 191,
): DurableTurnControlReceipt {
  return {
    receiptKind: "durable_turn_control_event",
    request,
    outcome: request.action === "turn.stop" ? "stopped" : "steered",
    activeDirectionEpoch: request.action === "turn.stop" ? null : request.directionEpoch + 1,
    globalSequence,
  };
}

describe("tranche-2 renderer control receipts", () => {
  it("accepts every workspace command only when the receipt echoes the exact complete request", () => {
    for (const request of workspaceRequests) {
      expect(validateWorkspaceControlReceipt(workspaceReceipt(request), request)).toMatchObject({
        request,
        globalSequence: 190,
      });
    }
  });

  it("rejects every changed reaction identity field, desired state, extra field, and invalid sequence", () => {
    const request = workspaceRequests.at(-1);
    if (!request || request.action !== "reaction.set") throw new Error("reaction fixture missing");
    const mutations: readonly Record<string, unknown>[] = [
      { ...request, workspaceId: "workspace-other" },
      { ...request, humanActorId: "human-other" },
      { ...request, clientRequestId: "client-other" },
      { ...request, conversationId: "conv-other" },
      { ...request, messageId: "message-other" },
      { ...request, reactionToken: "clear" },
      { ...request, present: false },
      { ...request, injected: true },
    ];
    for (const changed of mutations) {
      expect(() => validateWorkspaceControlReceipt({
        ...workspaceReceipt(request),
        request: changed,
      }, request)).toThrow("matching durable workspace receipt");
    }
    expect(() => validateWorkspaceControlReceipt({ ...workspaceReceipt(request), globalSequence: 0 }, request)).toThrow();
    expect(() => validateWorkspaceControlReceipt({ ...workspaceReceipt(request), injected: true }, request)).toThrow();
  });

  it("binds stop and steer receipts to action, workspace, human, conversation, turn, epoch, client ID, and direction", () => {
    const stop: TurnControlRequest = {
      ...base,
      action: "turn.stop",
      conversationId: "conv-memory-audit",
      turnId: "turn-memory-audit-019",
      directionEpoch: 3,
    };
    const steer: TurnControlRequest = {
      ...base,
      action: "turn.steer",
      conversationId: "conv-memory-audit",
      turnId: "turn-memory-audit-019",
      directionEpoch: 3,
      direction: "안전성 검사를 먼저 해줘",
    };
    expect(validateTurnControlReceipt(turnReceipt(stop), stop)).toMatchObject({ outcome: "stopped" });
    expect(validateTurnControlReceipt(turnReceipt(steer), steer)).toMatchObject({
      outcome: "steered",
      activeDirectionEpoch: 4,
    });

    const changedRequests: readonly Record<string, unknown>[] = [
      { ...steer, workspaceId: "workspace-other" },
      { ...steer, humanActorId: "human-other" },
      { ...steer, clientRequestId: "client-other" },
      { ...steer, conversationId: "conv-other" },
      { ...steer, turnId: "turn-other" },
      { ...steer, directionEpoch: 4 },
      { ...steer, direction: "changed" },
    ];
    for (const changed of changedRequests) {
      expect(() => validateTurnControlReceipt({ ...turnReceipt(steer), request: changed }, steer)).toThrow(
        "matching durable turn-control receipt",
      );
    }
    expect(() => validateTurnControlReceipt({ ...turnReceipt(stop), outcome: "steered" }, stop)).toThrow();
    expect(() => validateTurnControlReceipt({ ...turnReceipt(steer), activeDirectionEpoch: 5 }, steer)).toThrow();
  });

  it("does not ask for or expose a refreshed workspace view after a mismatched receipt", async () => {
    const request = workspaceRequests[0];
    if (request.action !== "agent.create") throw new Error("agent fixture missing");
    let viewReads = 0;
    const control: WorkspaceControlPort = {
      async execute() {
        return workspaceReceipt({ ...request, agentId: "fabricated-agent" });
      },
    };
    const view: ControlRoomViewPort = {
      async readAfter() {
        viewReads += 1;
        return { ...demoModel, lastGlobalSequence: 190 };
      },
    };
    await expect(executeWorkspaceControlMutation(control, view, request)).rejects.toThrow(
      "matching durable workspace receipt",
    );
    expect(viewReads).toBe(0);
  });

  it("returns durable UI state only after a matched receipt and a same-workspace snapshot through its sequence", async () => {
    const request = workspaceRequests[0];
    const steps: string[] = [];
    const control: WorkspaceControlPort = {
      async execute(received) {
        steps.push("receipt");
        return workspaceReceipt(received, 190);
      },
    };
    const view: ControlRoomViewPort = {
      async readAfter(received) {
        steps.push(`view:${received.minimumGlobalSequence}`);
        return { ...demoModel, lastGlobalSequence: 190 };
      },
    };
    const refreshed = await executeWorkspaceControlMutation(control, view, request);
    expect(steps).toEqual(["receipt", "view:190"]);
    expect(refreshed.lastGlobalSequence).toBe(190);

    const staleView: ControlRoomViewPort = {
      async readAfter() { return { ...demoModel, lastGlobalSequence: 189 }; },
    };
    await expect(executeWorkspaceControlMutation(control, staleView, request)).rejects.toThrow(
      "snapshot through the durable receipt sequence",
    );
    expect(() => validateRefreshedControlRoom(
      { ...demoModel, workspaceId: "workspace-other", lastGlobalSequence: 190 },
      request.workspaceId,
      request.humanActorId,
      190,
    )).toThrow();
    expect(() => validateRefreshedControlRoom(
      { ...demoModel, currentHumanId: "human-other", lastGlobalSequence: 190 },
      request.workspaceId,
      request.humanActorId,
      190,
    )).toThrow();
  });

  it("uses the same receipt-then-view gate for exact turn control", async () => {
    const request: TurnControlRequest = {
      ...base,
      action: "turn.stop",
      conversationId: "conv-memory-audit",
      turnId: "turn-memory-audit-019",
      directionEpoch: 3,
    };
    const turn: TurnControlPort = { async execute(received) { return turnReceipt(received, 192); } };
    const view: ControlRoomViewPort = {
      async readAfter({ workspaceId, humanActorId, minimumGlobalSequence }) {
        expect(workspaceId).toBe(request.workspaceId);
        expect(humanActorId).toBe(request.humanActorId);
        expect(minimumGlobalSequence).toBe(192);
        return { ...demoModel, lastGlobalSequence: 192, activeTurn: { ...demoModel.activeTurn!, state: "stopped" } };
      },
    };
    expect(await executeTurnControlMutation(turn, view, request)).toMatchObject({
      lastGlobalSequence: 192,
      activeTurn: { state: "stopped" },
    });
  });
});
