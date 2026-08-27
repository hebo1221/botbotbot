import { randomUUID } from "node:crypto";
import {
  AGENT_COLOR_TOKENS,
  AGENT_MARK_TOKENS,
  AGENT_STATUSES,
  REACTION_TOKENS,
  asId,
  systemClock,
  type Actor,
  type AgentColorToken,
  type AgentId,
  type AgentMarkToken,
  type AgentProfile,
  type AgentStatus,
  type AuditEvent,
  type AuditEventType,
  type Clock,
  type ConversationId,
  type DraftAuditEvent,
  type EventId,
  type MessageId,
  type ReactionToken,
  type SectionId,
  type WorkspaceId,
  type WorkspaceSection,
} from "../domain/contracts";
import { DurableJournal } from "../storage/durableJournal";
import { projectWorkspace, type WorkspaceProjection } from "../runtime/workspaceProjection";

const MAX_ID_LENGTH = 160;
const MAX_CLIENT_REQUEST_ID_LENGTH = 200;
const MAX_AGENT_NAME_LENGTH = 80;
const MAX_ROLE_TITLE_LENGTH = 120;
const MAX_SECTION_NAME_LENGTH = 80;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type WorkspaceCommandReason =
  | "invalid_actor"
  | "invalid_identifier"
  | "invalid_client_request_id"
  | "invalid_text"
  | "invalid_visual_token"
  | "invalid_status"
  | "invalid_status_transition"
  | "invalid_order_key"
  | "workspace_scope_invalid"
  | "entity_scope_invalid"
  | "duplicate_entity_id"
  | "revision_conflict"
  | "idempotency_mismatch"
  | "message_scope_invalid"
  | "invalid_reaction_token";

export class WorkspaceCommandError extends Error {
  constructor(
    readonly reasonCode: WorkspaceCommandReason,
    message = `Workspace command was rejected (${reasonCode}).`,
  ) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

export class RevisionConflictError extends WorkspaceCommandError {
  constructor(
    readonly entityKind: "agent" | "section" | "membership",
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super("revision_conflict", `${entityKind} revision conflict; refresh durable state before retrying.`);
    this.name = "RevisionConflictError";
  }
}

export type WorkspaceMutationOperation =
  | "agent_create"
  | "agent_update"
  | "section_create"
  | "section_rename"
  | "section_reorder"
  | "section_delete"
  | "membership_set";

export interface WorkspaceMutationReceipt {
  readonly receiptKind: "durable_workspace_event";
  readonly operation: WorkspaceMutationOperation;
  readonly workspaceId: WorkspaceId;
  readonly clientRequestId: string;
  readonly entityId: string;
  readonly revision: number;
  readonly globalSequence: number;
  readonly eventId: EventId;
  readonly unassignedAgentIds?: readonly AgentId[];
}

export interface ReactionMutationReceipt {
  readonly receiptKind: "durable_reaction_event";
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly humanActorId: string;
  readonly reactionToken: ReactionToken;
  readonly present: boolean;
  readonly clientRequestId: string;
  readonly globalSequence: number;
  readonly eventId: EventId;
}

export interface CreateAgentInput {
  readonly workspaceId: WorkspaceId;
  readonly agentId: AgentId;
  readonly clientRequestId: string;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly colorToken: AgentColorToken;
  readonly markToken: AgentMarkToken;
  readonly status?: AgentStatus;
  readonly actor: Actor;
}

export interface UpdateAgentInput {
  readonly workspaceId: WorkspaceId;
  readonly agentId: AgentId;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly roleTitle?: string;
  readonly colorToken?: AgentColorToken;
  readonly markToken?: AgentMarkToken;
  readonly status?: AgentStatus;
  readonly actor: Actor;
}

export interface CreateSectionInput {
  readonly workspaceId: WorkspaceId;
  readonly sectionId: SectionId;
  readonly clientRequestId: string;
  readonly name: string;
  readonly orderKey: number;
  readonly actor: Actor;
}

export interface RenameSectionInput {
  readonly workspaceId: WorkspaceId;
  readonly sectionId: SectionId;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly name: string;
  readonly actor: Actor;
}

export interface ReorderSectionInput {
  readonly workspaceId: WorkspaceId;
  readonly sectionId: SectionId;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly orderKey: number;
  readonly actor: Actor;
}

export interface SetAgentSectionInput {
  readonly workspaceId: WorkspaceId;
  readonly agentId: AgentId;
  readonly sectionId: SectionId | null;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly actor: Actor;
}

export interface DeleteSectionInput {
  readonly workspaceId: WorkspaceId;
  readonly sectionId: SectionId;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly actor: Actor;
}

export interface SetReactionInput {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly reactionToken: ReactionToken;
  readonly present: boolean;
  readonly clientRequestId: string;
  readonly actor: Actor;
}

function assertHuman(actor: Actor): void {
  if (actor.kind !== "human" || !boundedIdentifier(actor.id)) {
    throw new WorkspaceCommandError("invalid_actor");
  }
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value)
  );
}

function assertIdentifier(value: unknown): asserts value is string {
  if (!boundedIdentifier(value)) throw new WorkspaceCommandError("invalid_identifier");
}

function assertClientRequestId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CLIENT_REQUEST_ID_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new WorkspaceCommandError("invalid_client_request_id");
  }
}

function assertText(value: unknown, maximumLength: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new WorkspaceCommandError("invalid_text");
  }
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new WorkspaceCommandError("revision_conflict");
  }
}

function assertOrderKey(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) {
    throw new WorkspaceCommandError("invalid_order_key");
  }
}

function validStatusTransition(previous: AgentStatus, next: AgentStatus): boolean {
  if (previous === next) return true;
  const transitions: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
    idle: ["working", "stopped", "error"],
    working: ["idle", "waiting_for_human", "stopped", "error"],
    waiting_for_human: ["idle", "working", "stopped", "error"],
    stopped: ["idle", "error"],
    error: ["idle", "stopped"],
  };
  return transitions[previous].includes(next);
}

function workspaceExists(events: readonly AuditEvent[], workspaceId: WorkspaceId): boolean {
  return events.some((event) => event.workspaceId === workspaceId && event.type === "workspace.created");
}

function entityWorkspace(
  events: readonly AuditEvent[],
  entityId: string,
  createdType: "agent.profile.created" | "section.created",
  field: "agentId" | "sectionId",
): WorkspaceId | undefined {
  const created = events.find(
    (event) => event.type === createdType && (event.payload as Record<string, unknown>)[field] === entityId,
  );
  return created?.workspaceId;
}

function rootRequestEvents(events: readonly AuditEvent[], workspaceId: WorkspaceId, clientRequestId: string) {
  return events.filter((event) => {
    if (event.workspaceId !== workspaceId || !("clientRequestId" in event.payload)) return false;
    if ((event.payload as { clientRequestId?: string }).clientRequestId !== clientRequestId) return false;
    if (event.type === "agent.section.changed") {
      return (event.payload as { reason?: string }).reason === "user_assignment";
    }
    return [
      "agent.profile.created",
      "agent.profile.updated",
      "section.created",
      "section.renamed",
      "section.reordered",
      "section.deleted",
      "reaction.state.set",
    ].includes(event.type);
  });
}

function workspaceReceipt(
  event: AuditEvent,
  operation: WorkspaceMutationOperation,
  entityId: string,
  revision: number,
  unassignedAgentIds?: readonly AgentId[],
): WorkspaceMutationReceipt {
  return Object.freeze({
    receiptKind: "durable_workspace_event",
    operation,
    workspaceId: event.workspaceId,
    clientRequestId: String((event.payload as { clientRequestId: string }).clientRequestId),
    entityId,
    revision,
    globalSequence: event.globalSequence,
    eventId: event.eventId,
    ...(unassignedAgentIds ? { unassignedAgentIds: Object.freeze([...unassignedAgentIds]) } : {}),
  });
}

export class WorkspaceControlService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly journal: DurableJournal,
    private readonly clock: Clock = systemClock,
  ) {}

  snapshot(workspaceId: WorkspaceId): WorkspaceProjection {
    return projectWorkspace(this.journal.snapshot(), workspaceId);
  }

  createAgent(input: CreateAgentInput): Promise<WorkspaceMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.agentId);
      assertText(input.displayName, MAX_AGENT_NAME_LENGTH);
      assertText(input.roleTitle, MAX_ROLE_TITLE_LENGTH);
      if (!AGENT_COLOR_TOKENS.includes(input.colorToken)) throw new WorkspaceCommandError("invalid_visual_token");
      if (!AGENT_MARK_TOKENS.includes(input.markToken)) throw new WorkspaceCommandError("invalid_visual_token");
      const status = input.status ?? "idle";
      if (!AGENT_STATUSES.includes(status) || status !== "idle") {
        throw new WorkspaceCommandError("invalid_status");
      }
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, "agent.profile.created");
      if (duplicate) {
        const item = duplicate.payload as { agentId: string; displayName: string; roleTitle: string; colorToken: string; markToken: string; status: string; revision: number };
        if (
          item.agentId !== input.agentId || item.displayName !== input.displayName || item.roleTitle !== input.roleTitle ||
          item.colorToken !== input.colorToken || item.markToken !== input.markToken || item.status !== status
        ) throw new WorkspaceCommandError("idempotency_mismatch");
        return workspaceReceipt(duplicate, "agent_create", item.agentId, item.revision);
      }
      if (entityWorkspace(events, input.agentId, "agent.profile.created", "agentId")) {
        throw new WorkspaceCommandError("duplicate_entity_id");
      }
      const now = this.clock.now().toISOString();
      const event = await this.journal.append(this.event(input.workspaceId, undefined, input.actor, "agent.profile.created", {
        agentId: input.agentId,
        clientRequestId: input.clientRequestId,
        displayName: input.displayName,
        roleTitle: input.roleTitle,
        colorToken: input.colorToken,
        markToken: input.markToken,
        status,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      }));
      return workspaceReceipt(event, "agent_create", input.agentId, 1);
    });
  }

  updateAgent(input: UpdateAgentInput): Promise<WorkspaceMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.agentId);
      assertRevision(input.expectedRevision);
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, "agent.profile.updated");
      if (duplicate) {
        const item = duplicate.payload as { agentId: string; expectedRevision: number; displayName: string; roleTitle: string; colorToken: AgentColorToken; markToken: AgentMarkToken; status: AgentStatus; revision: number };
        const currentAtRequest = this.agentAtRevision(events, input.workspaceId, input.agentId, item.expectedRevision);
        const intended = currentAtRequest ? this.nextProfile(currentAtRequest, input) : undefined;
        if (!intended || item.agentId !== input.agentId || item.expectedRevision !== input.expectedRevision ||
          item.displayName !== intended.displayName || item.roleTitle !== intended.roleTitle || item.colorToken !== intended.colorToken ||
          item.markToken !== intended.markToken || item.status !== intended.status) {
          throw new WorkspaceCommandError("idempotency_mismatch");
        }
        return workspaceReceipt(duplicate, "agent_update", item.agentId, item.revision);
      }
      this.assertEntityScope(events, input.workspaceId, input.agentId, "agent.profile.created", "agentId");
      const current = projectWorkspace(events, input.workspaceId).agents[input.agentId];
      if (!current) throw new WorkspaceCommandError("entity_scope_invalid");
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflictError("agent", input.expectedRevision, current.revision);
      }
      const next = this.nextProfile(current, input);
      if (!validStatusTransition(current.status, next.status)) {
        throw new WorkspaceCommandError("invalid_status_transition");
      }
      const revision = current.revision + 1;
      const event = await this.journal.append(this.event(input.workspaceId, undefined, input.actor, "agent.profile.updated", {
        agentId: input.agentId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        displayName: next.displayName,
        roleTitle: next.roleTitle,
        colorToken: next.colorToken,
        markToken: next.markToken,
        status: next.status,
        updatedAt: this.clock.now().toISOString(),
        revision,
      }));
      return workspaceReceipt(event, "agent_update", input.agentId, revision);
    });
  }

  createSection(input: CreateSectionInput): Promise<WorkspaceMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.sectionId);
      assertText(input.name, MAX_SECTION_NAME_LENGTH);
      assertOrderKey(input.orderKey);
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, "section.created");
      if (duplicate) {
        const item = duplicate.payload as { sectionId: string; name: string; orderKey: number; revision: number };
        if (item.sectionId !== input.sectionId || item.name !== input.name || item.orderKey !== input.orderKey) {
          throw new WorkspaceCommandError("idempotency_mismatch");
        }
        return workspaceReceipt(duplicate, "section_create", item.sectionId, item.revision);
      }
      if (entityWorkspace(events, input.sectionId, "section.created", "sectionId")) {
        throw new WorkspaceCommandError("duplicate_entity_id");
      }
      const now = this.clock.now().toISOString();
      const event = await this.journal.append(this.event(input.workspaceId, undefined, input.actor, "section.created", {
        sectionId: input.sectionId,
        clientRequestId: input.clientRequestId,
        name: input.name,
        orderKey: input.orderKey,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      }));
      return workspaceReceipt(event, "section_create", input.sectionId, 1);
    });
  }

  renameSection(input: RenameSectionInput): Promise<WorkspaceMutationReceipt> {
    return this.mutateSection(input, "section.renamed", "section_rename", (section) => ({
      name: input.name,
      orderKey: section.orderKey,
    }));
  }

  reorderSection(input: ReorderSectionInput): Promise<WorkspaceMutationReceipt> {
    return this.mutateSection(input, "section.reordered", "section_reorder", (section) => ({
      name: section.name,
      orderKey: input.orderKey,
    }));
  }

  setAgentSection(input: SetAgentSectionInput): Promise<WorkspaceMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.agentId);
      if (input.sectionId !== null) assertIdentifier(input.sectionId);
      assertRevision(input.expectedRevision);
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, "agent.section.changed");
      if (duplicate) {
        const item = duplicate.payload as { agentId: string; sectionId: string | null; expectedRevision: number; revision: number; reason: string };
        if (item.reason !== "user_assignment" || item.agentId !== input.agentId || item.sectionId !== input.sectionId || item.expectedRevision !== input.expectedRevision) {
          throw new WorkspaceCommandError("idempotency_mismatch");
        }
        return workspaceReceipt(duplicate, "membership_set", item.agentId, item.revision);
      }
      this.assertEntityScope(events, input.workspaceId, input.agentId, "agent.profile.created", "agentId");
      if (input.sectionId !== null) {
        this.assertEntityScope(events, input.workspaceId, input.sectionId, "section.created", "sectionId");
      }
      const projection = projectWorkspace(events, input.workspaceId);
      const membership = projection.memberships[input.agentId];
      if (!projection.agents[input.agentId] || !membership ||
        (input.sectionId !== null && !projection.sections[input.sectionId])) {
        throw new WorkspaceCommandError("entity_scope_invalid");
      }
      if (membership.revision !== input.expectedRevision) {
        throw new RevisionConflictError("membership", input.expectedRevision, membership.revision);
      }
      const revision = membership.revision + 1;
      const event = await this.journal.append(this.event(input.workspaceId, undefined, input.actor, "agent.section.changed", {
        agentId: input.agentId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        previousSectionId: membership.sectionId ?? null,
        sectionId: input.sectionId,
        revision,
        changedAt: this.clock.now().toISOString(),
        reason: "user_assignment",
      }));
      return workspaceReceipt(event, "membership_set", input.agentId, revision);
    });
  }

  deleteSection(input: DeleteSectionInput): Promise<WorkspaceMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.sectionId);
      assertRevision(input.expectedRevision);
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, "section.deleted");
      if (duplicate) {
        const item = duplicate.payload as unknown as { sectionId: string; expectedRevision: number; revision: number; unassignedAgentIds: AgentId[] };
        if (item.sectionId !== input.sectionId || item.expectedRevision !== input.expectedRevision) {
          throw new WorkspaceCommandError("idempotency_mismatch");
        }
        return workspaceReceipt(duplicate, "section_delete", item.sectionId, item.revision, item.unassignedAgentIds);
      }
      this.assertEntityScope(events, input.workspaceId, input.sectionId, "section.created", "sectionId");
      const projection = projectWorkspace(events, input.workspaceId);
      const section = projection.sections[input.sectionId];
      if (!section) throw new WorkspaceCommandError("entity_scope_invalid");
      if (section.revision !== input.expectedRevision) {
        throw new RevisionConflictError("section", input.expectedRevision, section.revision);
      }
      const members = Object.values(projection.memberships)
        .filter((membership) => membership.sectionId === input.sectionId)
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
      const now = this.clock.now().toISOString();
      const derivedActor: Actor = { kind: "system", id: "workspace-control" };
      const drafts: DraftAuditEvent[] = members.map((membership) => this.event(
        input.workspaceId,
        undefined,
        derivedActor,
        "agent.section.changed",
        {
          agentId: membership.agentId,
          clientRequestId: input.clientRequestId,
          expectedRevision: membership.revision,
          previousSectionId: input.sectionId,
          sectionId: null,
          revision: membership.revision + 1,
          changedAt: now,
          reason: "section_deleted",
        },
      ));
      drafts.push(this.event(input.workspaceId, undefined, input.actor, "section.deleted", {
        sectionId: input.sectionId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        revision: section.revision + 1,
        unassignedAgentIds: members.map((membership) => membership.agentId),
        deletedAt: now,
      }));
      const appended = await this.journal.appendBatch(drafts);
      const terminal = appended.at(-1);
      if (!terminal) throw new Error("Section deletion did not produce a durable event");
      return workspaceReceipt(
        terminal,
        "section_delete",
        input.sectionId,
        section.revision + 1,
        members.map((membership) => membership.agentId),
      );
    });
  }

  setReaction(input: SetReactionInput): Promise<ReactionMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.conversationId);
      assertIdentifier(input.messageId);
      if (!REACTION_TOKENS.includes(input.reactionToken)) {
        throw new WorkspaceCommandError("invalid_reaction_token");
      }
      if (typeof input.present !== "boolean") throw new WorkspaceCommandError("invalid_reaction_token");
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, "reaction.state.set");
      if (duplicate) {
        const item = duplicate.payload as { messageId: MessageId; humanActorId: string; reactionToken: ReactionToken; present: boolean };
        if (duplicate.conversationId !== input.conversationId || item.messageId !== input.messageId ||
          item.humanActorId !== input.actor.id || item.reactionToken !== input.reactionToken || item.present !== input.present) {
          throw new WorkspaceCommandError("idempotency_mismatch");
        }
        return this.reactionReceipt(duplicate);
      }
      if (!this.messageExists(events, input.workspaceId, input.conversationId, input.messageId)) {
        throw new WorkspaceCommandError("message_scope_invalid");
      }
      const event = await this.journal.append(this.event(input.workspaceId, input.conversationId, input.actor, "reaction.state.set", {
        messageId: input.messageId,
        humanActorId: input.actor.id,
        reactionToken: input.reactionToken,
        present: input.present,
        clientRequestId: input.clientRequestId,
        setAt: this.clock.now().toISOString(),
      }));
      return this.reactionReceipt(event);
    });
  }

  private mutateSection(
    input: RenameSectionInput | ReorderSectionInput,
    type: "section.renamed" | "section.reordered",
    operation: "section_rename" | "section_reorder",
    next: (section: WorkspaceSection) => { readonly name: string; readonly orderKey: number },
  ): Promise<WorkspaceMutationReceipt> {
    return this.enqueue(async () => {
      this.validateCommon(input.workspaceId, input.clientRequestId, input.actor);
      assertIdentifier(input.sectionId);
      assertRevision(input.expectedRevision);
      if ("name" in input) assertText(input.name, MAX_SECTION_NAME_LENGTH);
      if ("orderKey" in input) assertOrderKey(input.orderKey);
      const events = this.journal.snapshot();
      const duplicate = this.findDuplicate(events, input.workspaceId, input.clientRequestId, input.actor.id, type);
      if (duplicate) {
        const item = duplicate.payload as { sectionId: string; expectedRevision: number; revision: number; name?: string; orderKey?: number };
        const matches = item.sectionId === input.sectionId && item.expectedRevision === input.expectedRevision &&
          (type === "section.renamed" ? item.name === (input as RenameSectionInput).name : item.orderKey === (input as ReorderSectionInput).orderKey);
        if (!matches) throw new WorkspaceCommandError("idempotency_mismatch");
        return workspaceReceipt(duplicate, operation, item.sectionId, item.revision);
      }
      this.assertEntityScope(events, input.workspaceId, input.sectionId, "section.created", "sectionId");
      const section = projectWorkspace(events, input.workspaceId).sections[input.sectionId];
      if (!section) throw new WorkspaceCommandError("entity_scope_invalid");
      if (section.revision !== input.expectedRevision) {
        throw new RevisionConflictError("section", input.expectedRevision, section.revision);
      }
      const value = next(section);
      const revision = section.revision + 1;
      const common = {
        sectionId: input.sectionId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        updatedAt: this.clock.now().toISOString(),
        revision,
      };
      const draft = type === "section.renamed"
        ? this.event(input.workspaceId, undefined, input.actor, type, { ...common, name: value.name })
        : this.event(input.workspaceId, undefined, input.actor, type, { ...common, orderKey: value.orderKey });
      const event = await this.journal.append(draft);
      return workspaceReceipt(event, operation, input.sectionId, revision);
    });
  }

  private nextProfile(current: AgentProfile, input: UpdateAgentInput): AgentProfile {
    const displayName = input.displayName ?? current.displayName;
    const roleTitle = input.roleTitle ?? current.roleTitle;
    const colorToken = input.colorToken ?? current.colorToken;
    const markToken = input.markToken ?? current.markToken;
    const status = input.status ?? current.status;
    assertText(displayName, MAX_AGENT_NAME_LENGTH);
    assertText(roleTitle, MAX_ROLE_TITLE_LENGTH);
    if (!AGENT_COLOR_TOKENS.includes(colorToken)) throw new WorkspaceCommandError("invalid_visual_token");
    if (!AGENT_MARK_TOKENS.includes(markToken)) throw new WorkspaceCommandError("invalid_visual_token");
    if (!AGENT_STATUSES.includes(status)) throw new WorkspaceCommandError("invalid_status");
    return { ...current, displayName, roleTitle, colorToken, markToken, status };
  }

  private agentAtRevision(
    events: readonly AuditEvent[],
    workspaceId: WorkspaceId,
    agentId: AgentId,
    revision: number,
  ): AgentProfile | undefined {
    const cutoff = events.findIndex((event) =>
      event.workspaceId === workspaceId &&
      ["agent.profile.created", "agent.profile.updated"].includes(event.type) &&
      (event.payload as { agentId?: string; revision?: number }).agentId === agentId &&
      (event.payload as { revision?: number }).revision === revision,
    );
    if (cutoff < 0) return undefined;
    return projectWorkspace(events.slice(0, cutoff + 1), workspaceId).agents[agentId];
  }

  private validateCommon(workspaceId: WorkspaceId, clientRequestId: string, actor: Actor): void {
    assertIdentifier(workspaceId);
    assertClientRequestId(clientRequestId);
    assertHuman(actor);
    if (!workspaceExists(this.journal.snapshot(), workspaceId)) {
      throw new WorkspaceCommandError("workspace_scope_invalid");
    }
  }

  private assertEntityScope(
    events: readonly AuditEvent[],
    workspaceId: WorkspaceId,
    entityId: string,
    type: "agent.profile.created" | "section.created",
    field: "agentId" | "sectionId",
  ): void {
    if (entityWorkspace(events, entityId, type, field) !== workspaceId) {
      throw new WorkspaceCommandError("entity_scope_invalid");
    }
  }

  private findDuplicate(
    events: readonly AuditEvent[],
    workspaceId: WorkspaceId,
    clientRequestId: string,
    actorId: string,
    expectedType: AuditEventType,
  ): AuditEvent | undefined {
    const roots = rootRequestEvents(events, workspaceId, clientRequestId);
    if (roots.length === 0) return undefined;
    const matching = roots.find((event) => event.type === expectedType);
    if (!matching || matching.actor.id !== actorId) {
      throw new WorkspaceCommandError("idempotency_mismatch");
    }
    return matching;
  }

  private messageExists(
    events: readonly AuditEvent[],
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    messageId: MessageId,
  ): boolean {
    const scoped = events.filter(
      (event) => event.workspaceId === workspaceId && event.conversationId === conversationId,
    );
    if (scoped.some((event) => event.type === "user.message.accepted" &&
      (event.payload as { messageId?: string }).messageId === messageId)) return true;
    if (scoped.some((event) => ["tool.execution.succeeded", "tool.execution.failed", "tool.execution.uncertain"].includes(event.type) &&
      (event.payload as { receipt?: { receiptId?: string } }).receipt?.receiptId === messageId)) return true;
    const completedStreams = new Set(scoped
      .filter((event) => event.type === "assistant.stream.completed")
      .map((event) => (event.payload as { streamId: string }).streamId));
    return scoped.some((event) => event.type === "assistant.stream.started" &&
      completedStreams.has((event.payload as { streamId: string }).streamId) &&
      (event.payload as { messageId?: string }).messageId === messageId);
  }

  private reactionReceipt(event: AuditEvent): ReactionMutationReceipt {
    const item = event.payload as {
      messageId: MessageId;
      humanActorId: string;
      reactionToken: ReactionToken;
      present: boolean;
      clientRequestId: string;
    };
    return Object.freeze({
      receiptKind: "durable_reaction_event",
      workspaceId: event.workspaceId,
      conversationId: event.conversationId as ConversationId,
      messageId: item.messageId,
      humanActorId: item.humanActorId,
      reactionToken: item.reactionToken,
      present: item.present,
      clientRequestId: item.clientRequestId,
      globalSequence: event.globalSequence,
      eventId: event.eventId,
    });
  }

  private event<Type extends AuditEventType>(
    workspaceId: WorkspaceId,
    conversationId: ConversationId | undefined,
    actor: Actor,
    type: Type,
    payload: DraftAuditEvent<Type>["payload"],
  ): DraftAuditEvent<Type> {
    return {
      eventId: asId<EventId>(randomUUID(), "event ID"),
      workspaceId,
      ...(conversationId ? { conversationId } : {}),
      actor,
      timestamp: this.clock.now().toISOString(),
      payloadSchemaVersion: 1,
      type,
      payload,
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
