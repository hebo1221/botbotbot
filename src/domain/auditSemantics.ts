import type {
  AgentStatus,
  AuditEvent,
  AuditPayloads,
} from "./contracts";
import { sha256Hex } from "./canonical";

interface RevisionedAgent {
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: AgentStatus;
}

interface RevisionedSection {
  readonly workspaceId: string;
  readonly revision: number;
  readonly deleted: boolean;
}

interface MembershipState {
  readonly workspaceId: string;
  readonly sectionId: string | null;
  readonly revision: number;
}

interface ScopedMessage {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly contentHash?: string;
}

interface StreamMessage extends ScopedMessage {
  readonly messageId: string;
}

interface ControlState extends ScopedMessage {
  readonly controlId: string;
  readonly kind: "stop" | "steer";
  readonly turnId: string;
  readonly directionEpoch: number;
  readonly clientRequestId: string;
  readonly directionHash: string;
  readonly terminal: boolean;
}

interface DirectionState extends ScopedMessage {
  readonly directionId: string;
  readonly turnId: string;
  readonly directionEpoch: number;
  readonly clientRequestId: string;
  readonly messageId: string;
  readonly contentHash: string;
  readonly kind: "initial" | "steer" | "follow_up";
}

export interface AuditSemanticState {
  readonly conversations: Map<string, string>;
  readonly agents: Map<string, RevisionedAgent>;
  readonly sections: Map<string, RevisionedSection>;
  readonly memberships: Map<string, MembershipState>;
  readonly messages: Map<string, ScopedMessage>;
  readonly streams: Map<string, StreamMessage>;
  readonly turns: Map<string, ScopedMessage>;
  readonly controls: Map<string, ControlState>;
  readonly directions: Map<string, DirectionState>;
  readonly derivedUnassignments: Map<string, Set<string>>;
}

export function emptyAuditSemanticState(): AuditSemanticState {
  return {
    conversations: new Map(),
    agents: new Map(),
    sections: new Map(),
    memberships: new Map(),
    messages: new Map(),
    streams: new Map(),
    turns: new Map(),
    controls: new Map(),
    directions: new Map(),
    derivedUnassignments: new Map(),
  };
}

export function cloneAuditSemanticState(state: AuditSemanticState): AuditSemanticState {
  return {
    conversations: new Map(state.conversations),
    agents: new Map(state.agents),
    sections: new Map(state.sections),
    memberships: new Map(state.memberships),
    messages: new Map(state.messages),
    streams: new Map(state.streams),
    turns: new Map(state.turns),
    controls: new Map(state.controls),
    directions: new Map(state.directions),
    derivedUnassignments: new Map(
      [...state.derivedUnassignments].map(([key, value]) => [key, new Set(value)]),
    ),
  };
}

function scopeOf(event: AuditEvent): ScopedMessage | undefined {
  return event.conversationId
    ? { workspaceId: event.workspaceId, conversationId: event.conversationId }
    : undefined;
}

function scopeMatches(left: ScopedMessage | undefined, right: ScopedMessage | undefined): boolean {
  return Boolean(
    left && right &&
    left.workspaceId === right.workspaceId &&
    left.conversationId === right.conversationId,
  );
}

function legalStatusTransition(previous: AgentStatus, next: AgentStatus): boolean {
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

function assignmentBatchKey(
  workspaceId: string,
  clientRequestId: string,
  sectionId: string,
): string {
  return JSON.stringify([workspaceId, clientRequestId, sectionId]);
}

/**
 * Applies cross-record invariants that cannot be established by payload shape
 * alone. A reason code means the event must not be written or replayed.
 */
export function applyAuditSemanticEvent(
  state: AuditSemanticState,
  event: AuditEvent,
): string | undefined {
  switch (event.type) {
    case "conversation.created": {
      const existing = state.conversations.get(event.conversationId ?? "");
      if (existing && existing !== event.workspaceId) return "conversation_workspace_conflict";
      if (event.conversationId) state.conversations.set(event.conversationId, event.workspaceId);
      return undefined;
    }
    case "agent.profile.created": {
      const item = event.payload as AuditPayloads["agent.profile.created"];
      if (state.agents.has(item.agentId)) return "duplicate_agent_id";
      if (item.status !== "idle") return "invalid_initial_agent_status";
      state.agents.set(item.agentId, {
        workspaceId: event.workspaceId,
        revision: item.revision,
        status: item.status,
      });
      state.memberships.set(item.agentId, {
        workspaceId: event.workspaceId,
        sectionId: null,
        revision: 0,
      });
      return undefined;
    }
    case "agent.profile.updated": {
      const item = event.payload as AuditPayloads["agent.profile.updated"];
      const current = state.agents.get(item.agentId);
      if (!current || current.workspaceId !== event.workspaceId) return "agent_workspace_scope_invalid";
      if (current.revision !== item.expectedRevision || item.revision !== current.revision + 1) {
        return "agent_revision_conflict";
      }
      if (!legalStatusTransition(current.status, item.status)) return "invalid_agent_status_transition";
      state.agents.set(item.agentId, {
        workspaceId: current.workspaceId,
        revision: item.revision,
        status: item.status,
      });
      return undefined;
    }
    case "section.created": {
      const item = event.payload as AuditPayloads["section.created"];
      if (state.sections.has(item.sectionId)) return "duplicate_section_id";
      state.sections.set(item.sectionId, {
        workspaceId: event.workspaceId,
        revision: item.revision,
        deleted: false,
      });
      return undefined;
    }
    case "section.renamed":
    case "section.reordered": {
      const item = event.payload as AuditPayloads["section.renamed" | "section.reordered"];
      const current = state.sections.get(item.sectionId);
      if (!current || current.workspaceId !== event.workspaceId || current.deleted) {
        return "section_workspace_scope_invalid";
      }
      if (current.revision !== item.expectedRevision || item.revision !== current.revision + 1) {
        return "section_revision_conflict";
      }
      state.sections.set(item.sectionId, { ...current, revision: item.revision });
      return undefined;
    }
    case "agent.section.changed": {
      const item = event.payload as AuditPayloads["agent.section.changed"];
      const agent = state.agents.get(item.agentId);
      const membership = state.memberships.get(item.agentId);
      if (!agent || !membership || agent.workspaceId !== event.workspaceId || membership.workspaceId !== event.workspaceId) {
        return "membership_workspace_scope_invalid";
      }
      if (item.sectionId !== null) {
        const section = state.sections.get(item.sectionId);
        if (!section || section.workspaceId !== event.workspaceId || section.deleted) {
          return "membership_workspace_scope_invalid";
        }
      }
      if (
        membership.revision !== item.expectedRevision ||
        item.revision !== membership.revision + 1 ||
        membership.sectionId !== item.previousSectionId
      ) {
        return "membership_revision_conflict";
      }
      state.memberships.set(item.agentId, {
        workspaceId: event.workspaceId,
        sectionId: item.sectionId,
        revision: item.revision,
      });
      if (item.reason === "section_deleted" && item.previousSectionId !== null) {
        const key = assignmentBatchKey(event.workspaceId, item.clientRequestId, item.previousSectionId);
        const identities = state.derivedUnassignments.get(key) ?? new Set<string>();
        identities.add(item.agentId);
        state.derivedUnassignments.set(key, identities);
      }
      return undefined;
    }
    case "section.deleted": {
      const item = event.payload as AuditPayloads["section.deleted"];
      const current = state.sections.get(item.sectionId);
      if (!current || current.workspaceId !== event.workspaceId || current.deleted) {
        return "section_workspace_scope_invalid";
      }
      if (current.revision !== item.expectedRevision || item.revision !== current.revision + 1) {
        return "section_revision_conflict";
      }
      const key = assignmentBatchKey(event.workspaceId, item.clientRequestId, item.sectionId);
      const derived = [...(state.derivedUnassignments.get(key) ?? new Set<string>())].sort();
      const declared = [...item.unassignedAgentIds].sort();
      if (JSON.stringify(derived) !== JSON.stringify(declared)) return "section_delete_membership_mismatch";
      if ([...state.memberships.values()].some((membership) => membership.sectionId === item.sectionId)) {
        return "section_delete_membership_remaining";
      }
      state.sections.set(item.sectionId, { ...current, revision: item.revision, deleted: true });
      state.derivedUnassignments.delete(key);
      return undefined;
    }
    case "user.message.accepted": {
      const item = event.payload as AuditPayloads["user.message.accepted"];
      const scope = scopeOf(event);
      if (!scope) return "message_scope_invalid";
      const knownConversation = state.conversations.get(scope.conversationId);
      if (knownConversation && knownConversation !== scope.workspaceId) return "message_scope_invalid";
      const previousMessage = state.messages.get(item.messageId);
      if (previousMessage && !scopeMatches(previousMessage, scope)) return "message_scope_invalid";
      state.messages.set(item.messageId, { ...scope, contentHash: sha256Hex(item.content) });
      const previousTurn = state.turns.get(item.turnId);
      if (previousTurn && !scopeMatches(previousTurn, scope)) return "turn_scope_invalid";
      state.turns.set(item.turnId, scope);
      return undefined;
    }
    case "assistant.stream.started": {
      const item = event.payload as AuditPayloads["assistant.stream.started"];
      const scope = scopeOf(event);
      if (!scope) return "stream_scope_invalid";
      const turn = state.turns.get(item.turnId);
      if (turn && !scopeMatches(turn, scope)) return "turn_scope_invalid";
      const existing = state.streams.get(item.streamId);
      if (existing && (!scopeMatches(existing, scope) || existing.messageId !== item.messageId)) {
        return "stream_scope_invalid";
      }
      state.streams.set(item.streamId, { ...scope, messageId: item.messageId });
      return undefined;
    }
    case "assistant.stream.completed": {
      const item = event.payload as AuditPayloads["assistant.stream.completed"];
      const scope = scopeOf(event);
      const stream = state.streams.get(item.streamId);
      if (stream && scopeMatches(stream, scope)) {
        state.messages.set(stream.messageId, {
          workspaceId: stream.workspaceId,
          conversationId: stream.conversationId,
        });
      }
      return undefined;
    }
    case "tool.execution.succeeded":
    case "tool.execution.failed":
    case "tool.execution.uncertain": {
      const item = event.payload as AuditPayloads[
        | "tool.execution.succeeded"
        | "tool.execution.failed"
        | "tool.execution.uncertain"
      ];
      const scope = scopeOf(event);
      if (scope) state.messages.set(item.receipt.receiptId, scope);
      return undefined;
    }
    case "reaction.state.set": {
      const item = event.payload as AuditPayloads["reaction.state.set"];
      const message = state.messages.get(item.messageId);
      if (!scopeMatches(message, scopeOf(event))) return "reaction_message_scope_invalid";
      return undefined;
    }
    case "human.control.requested": {
      const item = event.payload as AuditPayloads["human.control.requested"];
      const scope = scopeOf(event);
      const turn = state.turns.get(item.turnId);
      if (!scopeMatches(turn, scope)) return "control_turn_scope_invalid";
      if (state.controls.has(item.controlId)) return "duplicate_control_id";
      if (!scope) return "control_turn_scope_invalid";
      state.controls.set(item.controlId, {
        ...scope,
        controlId: item.controlId,
        kind: item.controlKind,
        turnId: item.turnId,
        directionEpoch: item.directionEpoch,
        clientRequestId: item.clientRequestId,
        directionHash: item.directionHash,
        terminal: false,
      });
      return undefined;
    }
    case "direction.accepted": {
      const item = event.payload as AuditPayloads["direction.accepted"];
      const scope = scopeOf(event);
      if (!scopeMatches(state.turns.get(item.turnId), scope)) return "direction_turn_scope_invalid";
      const message = state.messages.get(item.messageId);
      if (!scopeMatches(message, scope)) return "direction_message_scope_invalid";
      if (message?.contentHash !== item.contentHash) return "direction_content_hash_mismatch";
      if (state.directions.has(item.directionId)) return "duplicate_direction_id";
      if (!scope) return "direction_turn_scope_invalid";
      if (item.kind === "steer") {
        const control = [...state.controls.values()].find((candidate) =>
          candidate.kind === "steer" &&
          candidate.turnId === item.turnId &&
          candidate.clientRequestId === item.clientRequestId &&
          candidate.directionEpoch + 1 === item.directionEpoch &&
          candidate.directionHash === item.contentHash &&
          scopeMatches(candidate, scope)
        );
        if (!control) return "direction_control_mismatch";
      }
      state.directions.set(item.directionId, {
        ...scope,
        directionId: item.directionId,
        turnId: item.turnId,
        directionEpoch: item.directionEpoch,
        clientRequestId: item.clientRequestId,
        messageId: item.messageId,
        contentHash: item.contentHash,
        kind: item.kind,
      });
      return undefined;
    }
    case "turn.stopped": {
      const item = event.payload as AuditPayloads["turn.stopped"];
      const scope = scopeOf(event);
      const control = state.controls.get(item.controlId);
      if (
        !control || control.terminal || control.kind !== "stop" ||
        control.turnId !== item.turnId ||
        control.directionEpoch !== item.directionEpoch ||
        control.clientRequestId !== item.clientRequestId ||
        !scopeMatches(control, scope)
      ) return "stop_control_mismatch";
      state.controls.set(item.controlId, { ...control, terminal: true });
      return undefined;
    }
    case "turn.steered": {
      const item = event.payload as AuditPayloads["turn.steered"];
      const scope = scopeOf(event);
      const control = state.controls.get(item.controlId);
      const direction = state.directions.get(item.directionId);
      if (
        !control || control.terminal || control.kind !== "steer" ||
        control.turnId !== item.turnId ||
        control.directionEpoch !== item.retiredDirectionEpoch ||
        control.clientRequestId !== item.clientRequestId ||
        !scopeMatches(control, scope) ||
        !direction || direction.turnId !== item.turnId ||
        direction.directionEpoch !== item.nextDirectionEpoch ||
        direction.clientRequestId !== item.clientRequestId ||
        !scopeMatches(direction, scope)
      ) return "steer_control_mismatch";
      state.controls.set(item.controlId, { ...control, terminal: true });
      return undefined;
    }
    default:
      return undefined;
  }
}
