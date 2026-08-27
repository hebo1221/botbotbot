import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asId,
  type Actor,
  type AgentId,
  type ConversationId,
  type EventId,
  type MessageId,
  type SectionId,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import {
  RevisionConflictError,
  WorkspaceCommandError,
  WorkspaceControlService,
} from "../src/application/workspaceControlService";
import { projectConversation } from "../src/runtime/conversationProjection";
import { DurableJournal } from "../src/storage/durableJournal";
import { MutableClock, TempArea } from "./helpers";

const temporary = new TempArea();
afterEach(() => temporary.cleanup());

const owner: Actor = { kind: "human", id: "human-owner" };
const workspaceId = asId<WorkspaceId>("ws-directory");
const otherWorkspaceId = asId<WorkspaceId>("ws-foreign");
const conversationId = asId<ConversationId>("conv-directory");
const messageId = asId<MessageId>("message-directory");
const clock = new MutableClock(Date.parse("2026-08-26T00:00:00.000Z"));

async function harness() {
  const directory = await temporary.directory();
  const path = join(directory, "workspace.journal");
  const journal = await DurableJournal.open(path);
  for (const [index, id] of [workspaceId, otherWorkspaceId].entries()) {
    await journal.append({
      eventId: asId<EventId>(`workspace-event-${index}`),
      workspaceId: id,
      actor: owner,
      timestamp: clock.now().toISOString(),
      payloadSchemaVersion: 1,
      type: "workspace.created",
      payload: { name: `Workspace ${index}`, createdAt: clock.now().toISOString() },
    });
  }
  return { path, journal, service: new WorkspaceControlService(journal, clock) };
}

async function createAgent(service: WorkspaceControlService, agentId: AgentId, requestId: string, workspace = workspaceId) {
  return service.createAgent({
    workspaceId: workspace,
    agentId,
    clientRequestId: requestId,
    displayName: `Agent ${agentId}`,
    roleTitle: "Evidence navigator",
    colorToken: "relay-cobalt",
    markToken: "orbit",
    actor: owner,
  });
}

describe("WorkspaceControlService", () => {
  it("persists revisioned profiles and returns the original result for a duplicate request after restart", async () => {
    const agentId = asId<AgentId>("agent-persistent");
    const { path, journal, service } = await harness();
    const created = await createAgent(service, agentId, "agent-create-once");
    const updated = await service.updateAgent({
      workspaceId,
      agentId,
      clientRequestId: "agent-update-once",
      expectedRevision: 1,
      displayName: "Persistent agent",
      status: "working",
      actor: owner,
    });
    expect(created.revision).toBe(1);
    expect(updated.revision).toBe(2);
    await journal.close();

    const reopened = await DurableJournal.open(path);
    const restarted = new WorkspaceControlService(reopened, clock);
    expect(await restarted.updateAgent({
      workspaceId,
      agentId,
      clientRequestId: "agent-update-once",
      expectedRevision: 1,
      displayName: "Persistent agent",
      status: "working",
      actor: owner,
    })).toEqual(updated);
    await expect(restarted.updateAgent({
      workspaceId,
      agentId,
      clientRequestId: "agent-update-once",
      expectedRevision: 1,
      displayName: "Persistent agent",
      status: "working",
      actor: { kind: "human", id: "different-human" },
    })).rejects.toMatchObject({ reasonCode: "idempotency_mismatch" });
    expect(restarted.snapshot(workspaceId).agents[agentId]).toMatchObject({
      displayName: "Persistent agent",
      status: "working",
      revision: 2,
    });
    expect(reopened.snapshot().filter((event) => event.type === "agent.profile.updated")).toHaveLength(1);
    await reopened.close();
  });

  it("serializes concurrent expected revisions so one update wins and stale profile/section writes add zero events", async () => {
    const agentId = asId<AgentId>("agent-conflict");
    const sectionId = asId<SectionId>("section-conflict");
    const { journal, service } = await harness();
    await createAgent(service, agentId, "create-conflict-agent");
    await service.createSection({
      workspaceId, sectionId, clientRequestId: "create-conflict-section", name: "Evidence", orderKey: 10, actor: owner,
    });
    const baseline = journal.snapshot().length;
    const results = await Promise.allSettled([
      service.updateAgent({ workspaceId, agentId, clientRequestId: "race-agent-a", expectedRevision: 1, roleTitle: "First", actor: owner }),
      service.updateAgent({ workspaceId, agentId, clientRequestId: "race-agent-b", expectedRevision: 1, roleTitle: "Second", actor: owner }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof RevisionConflictError)).toHaveLength(1);
    expect(journal.snapshot()).toHaveLength(baseline + 1);
    const beforeSectionConflict = journal.snapshot().length;
    await service.renameSection({ workspaceId, sectionId, clientRequestId: "rename-section", expectedRevision: 1, name: "Verified evidence", actor: owner });
    await expect(service.reorderSection({
      workspaceId, sectionId, clientRequestId: "stale-reorder", expectedRevision: 1, orderKey: 20, actor: owner,
    })).rejects.toBeInstanceOf(RevisionConflictError);
    expect(journal.snapshot()).toHaveLength(beforeSectionConflict + 1);
    await journal.close();
  });

  it("rejects a negative section order key at the command boundary before any journal write", async () => {
    const { journal, service } = await harness();
    const baseline = journal.snapshot().length;
    await expect(service.createSection({
      workspaceId,
      sectionId: asId<SectionId>("section-negative-order"),
      clientRequestId: "negative-order",
      name: "Invalid order",
      orderKey: -1,
      actor: owner,
    })).rejects.toMatchObject({ reasonCode: "invalid_order_key" });
    expect(journal.snapshot()).toHaveLength(baseline);
    await journal.close();
  });

  it("deletes a populated section atomically while preserving profiles and advancing memberships to unassigned", async () => {
    const firstId = asId<AgentId>("agent-section-a");
    const secondId = asId<AgentId>("agent-section-b");
    const sectionId = asId<SectionId>("section-populated");
    const { journal, service } = await harness();
    await createAgent(service, firstId, "create-agent-a");
    await createAgent(service, secondId, "create-agent-b");
    await service.createSection({ workspaceId, sectionId, clientRequestId: "create-populated", name: "Active research", orderKey: 1, actor: owner });
    await service.setAgentSection({ workspaceId, agentId: firstId, sectionId, clientRequestId: "assign-a", expectedRevision: 0, actor: owner });
    await service.setAgentSection({ workspaceId, agentId: secondId, sectionId, clientRequestId: "assign-b", expectedRevision: 0, actor: owner });
    const before = service.snapshot(workspaceId);
    const receipt = await service.deleteSection({ workspaceId, sectionId, clientRequestId: "delete-populated", expectedRevision: 1, actor: owner });
    const after = service.snapshot(workspaceId);
    expect(receipt.unassignedAgentIds).toEqual([firstId, secondId]);
    expect(after.sections[sectionId]).toBeUndefined();
    expect(after.unassignedAgentIds).toEqual([firstId, secondId]);
    expect(after.agents[firstId]).toEqual(before.agents[firstId]);
    expect(after.agents[secondId]).toEqual(before.agents[secondId]);
    expect(after.memberships[firstId].revision).toBe(2);
    expect(after.memberships[firstId].sectionId).toBeUndefined();
    expect(after.memberships[secondId].revision).toBe(2);
    expect(after.memberships[secondId].sectionId).toBeUndefined();
    expect(journal.snapshot().filter((event) => event.type === "section.deleted")).toHaveLength(1);
    await journal.close();
  });

  it("rejects foreign and unknown assignment targets with the same scope-safe error and no write", async () => {
    const localId = asId<AgentId>("agent-local");
    const foreignSection = asId<SectionId>("section-foreign");
    const { journal, service } = await harness();
    await createAgent(service, localId, "create-local");
    await service.createSection({
      workspaceId: otherWorkspaceId,
      sectionId: foreignSection,
      clientRequestId: "create-foreign-section",
      name: "Foreign",
      orderKey: 1,
      actor: owner,
    });
    const baseline = journal.snapshot().length;
    for (const sectionId of [foreignSection, asId<SectionId>("section-unknown")]) {
      await expect(service.setAgentSection({
        workspaceId,
        agentId: localId,
        sectionId,
        clientRequestId: `assign-${sectionId}`,
        expectedRevision: 0,
        actor: owner,
      })).rejects.toMatchObject({ reasonCode: "entity_scope_invalid" });
    }
    expect(journal.snapshot()).toHaveLength(baseline);
    await journal.close();
  });

  it("retains 200 concurrent independent reaction identities exactly once and reconstructs them on restart", async () => {
    const { path, journal, service } = await harness();
    await journal.append({
      eventId: asId<EventId>("conversation-created-reactions"), workspaceId, conversationId, actor: owner,
      timestamp: clock.now().toISOString(), payloadSchemaVersion: 1, type: "conversation.created",
      payload: { title: "Reactions", createdAt: clock.now().toISOString() },
    });
    await journal.append({
      eventId: asId<EventId>("message-created-reactions"), workspaceId, conversationId, actor: owner,
      timestamp: clock.now().toISOString(), payloadSchemaVersion: 1, type: "user.message.accepted",
      payload: { messageId, turnId: asId<TurnId>("turn-reactions"), clientRequestId: "message-reactions", content: "React independently" },
    });
    await Promise.all(Array.from({ length: 200 }, (_, index) => service.setReaction({
      workspaceId,
      conversationId,
      messageId,
      reactionToken: "useful",
      present: true,
      clientRequestId: `reaction-${index}`,
      actor: { kind: "human", id: `human-${index}` },
    })));
    const before = projectConversation(journal.snapshot(), conversationId);
    expect(before.reactionStates).toHaveLength(200);
    expect(before.reactionStates.every((state) => state.present)).toBe(true);
    await journal.close();
    const reopened = await DurableJournal.open(path);
    expect(projectConversation(reopened.snapshot(), conversationId).reactionStates).toEqual(before.reactionStates);
    await reopened.close();
  });

  it("resolves competing writes to one reaction identity by journal sequence without deleting unrelated identities", async () => {
    const { journal, service } = await harness();
    await journal.append({
      eventId: asId<EventId>("conversation-created-same-reaction"), workspaceId, conversationId, actor: owner,
      timestamp: clock.now().toISOString(), payloadSchemaVersion: 1, type: "conversation.created",
      payload: { title: "Same reaction", createdAt: clock.now().toISOString() },
    });
    await journal.append({
      eventId: asId<EventId>("message-created-same-reaction"), workspaceId, conversationId, actor: owner,
      timestamp: clock.now().toISOString(), payloadSchemaVersion: 1, type: "user.message.accepted",
      payload: { messageId, turnId: asId<TurnId>("turn-same-reaction"), clientRequestId: "message-same", content: "Resolve by sequence" },
    });
    await Promise.all([
      service.setReaction({ workspaceId, conversationId, messageId, reactionToken: "clear", present: true, clientRequestId: "same-1", actor: owner }),
      service.setReaction({ workspaceId, conversationId, messageId, reactionToken: "clear", present: false, clientRequestId: "same-2", actor: owner }),
      service.setReaction({ workspaceId, conversationId, messageId, reactionToken: "clear", present: true, clientRequestId: "same-3", actor: owner }),
      service.setReaction({ workspaceId, conversationId, messageId, reactionToken: "celebrate", present: true, clientRequestId: "unrelated", actor: { kind: "human", id: "human-other" } }),
    ]);
    const projection = projectConversation(journal.snapshot(), conversationId);
    expect(projection.reactionStates).toHaveLength(2);
    expect(projection.reactionStates.find((state) => state.humanActorId === owner.id && state.reactionToken === "clear")?.present).toBe(true);
    expect(projection.reactionStates.find((state) => state.reactionToken === "celebrate")?.present).toBe(true);
    expect(projection.reactions[messageId]).toEqual(["celebrate", "clear"]);
    await expect(service.setReaction({
      workspaceId, conversationId, messageId, reactionToken: "clear", present: false,
      clientRequestId: "same-3", actor: owner,
    })).rejects.toBeInstanceOf(WorkspaceCommandError);
    await journal.close();
  });
});
