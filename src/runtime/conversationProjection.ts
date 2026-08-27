import {
  asId,
  type AuditEvent,
  type AuditPayloads,
  type AuditedToolProposal,
  type ConversationId,
  type MessageId,
  type NormalizedMessage,
  type ProviderHistoryRecord,
  type TurnId,
} from "../domain/contracts";

export type ProviderHistoryErrorCode =
  | "empty_provider_history"
  | "invalid_provider_history"
  | "duplicate_provider_history_id"
  | "broken_provider_history_alternation"
  | "incomplete_durable_tool_history";

export class ProviderHistoryError extends Error {
  constructor(readonly reasonCode: ProviderHistoryErrorCode) {
    super(`Provider history projection stopped (${reasonCode}).`);
    this.name = "ProviderHistoryError";
  }
}

interface PendingAssistant {
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly createdAt: string;
  chunks: string[];
  proposal?: AuditedToolProposal;
}

export interface ConversationProjection {
  readonly conversationId: ConversationId;
  readonly title: string;
  readonly normalizedHistory: readonly NormalizedMessage[];
  readonly reactions: Readonly<Record<string, readonly string[]>>;
  readonly reactionStates: readonly ReactionIdentityState[];
  readonly agentStatuses: Readonly<Record<string, string>>;
  readonly eventCount: number;
  readonly lastGlobalSequence: number;
}

export interface ReactionIdentityState {
  readonly messageId: MessageId;
  readonly humanActorId: string;
  readonly reactionToken: string;
  readonly present: boolean;
  readonly lastGlobalSequence: number;
}

function payload<Type extends keyof AuditPayloads>(event: AuditEvent, type: Type): AuditPayloads[Type] {
  if (event.type !== type) throw new Error(`Expected ${type}, received ${event.type}`);
  return event.payload as AuditPayloads[Type];
}

export function projectConversation(
  events: readonly AuditEvent[],
  conversationId: ConversationId,
): ConversationProjection {
  const history: NormalizedMessage[] = [];
  const pending = new Map<string, PendingAssistant>();
  const reactions = new Map<string, Set<string>>();
  const reactionIdentities = new Map<string, ReactionIdentityState>();
  const statuses = new Map<string, string>();
  let title = "Untitled conversation";
  let eventCount = 0;
  let lastGlobalSequence = 0;

  for (const event of events) {
    if (event.conversationId !== conversationId) continue;
    eventCount += 1;
    lastGlobalSequence = event.globalSequence;

    switch (event.type) {
      case "conversation.created": {
        title = payload(event, "conversation.created").title;
        break;
      }
      case "conversation.title.changed": {
        title = payload(event, "conversation.title.changed").title;
        break;
      }
      case "message.reaction.changed": {
        const item = payload(event, "message.reaction.changed");
        const set = reactions.get(item.messageId) ?? new Set<string>();
        if (item.enabled) set.add(item.reaction);
        else set.delete(item.reaction);
        reactions.set(item.messageId, set);
        break;
      }
      case "reaction.state.set": {
        const item = payload(event, "reaction.state.set");
        const identityKey = JSON.stringify([item.messageId, item.humanActorId, item.reactionToken]);
        reactionIdentities.set(identityKey, Object.freeze({
          messageId: item.messageId,
          humanActorId: item.humanActorId,
          reactionToken: item.reactionToken,
          present: item.present,
          lastGlobalSequence: event.globalSequence,
        }));
        break;
      }
      case "agent.status.changed": {
        const item = payload(event, "agent.status.changed");
        statuses.set(item.agentId, item.status);
        break;
      }
      case "user.message.accepted": {
        const item = payload(event, "user.message.accepted");
        history.push({
          id: item.messageId,
          role: "user",
          content: item.content,
          createdAt: event.timestamp,
        });
        break;
      }
      case "assistant.stream.started": {
        const item = payload(event, "assistant.stream.started");
        pending.set(item.streamId, {
          messageId: item.messageId,
          turnId: item.turnId,
          createdAt: event.timestamp,
          chunks: [],
        });
        break;
      }
      case "assistant.stream.advanced": {
        const item = payload(event, "assistant.stream.advanced");
        pending.get(item.streamId)?.chunks.push(item.delta);
        break;
      }
      case "tool.proposed": {
        const item = payload(event, "tool.proposed");
        const stream = [...pending.values()].reverse().find((candidate) => candidate.turnId === item.turnId);
        if (stream) stream.proposal = item.proposal;
        break;
      }
      case "assistant.stream.completed": {
        const item = payload(event, "assistant.stream.completed");
        const stream = pending.get(item.streamId);
        if (!stream) break;
        history.push({
          id: stream.messageId,
          role: "assistant",
          content: stream.chunks.join(""),
          createdAt: stream.createdAt,
          toolCall: stream.proposal
            ? {
                proposalId: stream.proposal.proposalId,
                toolId: stream.proposal.manifest.toolId,
                argumentsHash: stream.proposal.argumentsHash,
              }
            : undefined,
        });
        pending.delete(item.streamId);
        break;
      }
      case "assistant.stream.cancelled": {
        pending.delete(payload(event, "assistant.stream.cancelled").streamId);
        break;
      }
      case "turn.stopped": {
        const item = payload(event, "turn.stopped");
        for (const [streamId, stream] of pending) {
          if (stream.turnId === item.turnId) pending.delete(streamId);
        }
        break;
      }
      case "turn.steered": {
        const item = payload(event, "turn.steered");
        for (const [streamId, stream] of pending) {
          if (stream.turnId === item.turnId) pending.delete(streamId);
        }
        break;
      }
      case "tool.execution.succeeded":
      case "tool.execution.failed":
      case "tool.execution.uncertain": {
        const receipt = (event.payload as AuditPayloads[
          | "tool.execution.succeeded"
          | "tool.execution.failed"
          | "tool.execution.uncertain"
        ]).receipt;
        history.push({
          id: asId<MessageId>(receipt.receiptId, "tool result message ID"),
          role: "tool",
          content: receipt.outputSummary,
          createdAt: event.timestamp,
          receiptId: receipt.receiptId,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const state of reactionIdentities.values()) {
    const set = reactions.get(state.messageId) ?? new Set<string>();
    if (state.present) set.add(state.reactionToken);
    else {
      const anotherPresent = [...reactionIdentities.values()].some((candidate) =>
        candidate.messageId === state.messageId &&
        candidate.reactionToken === state.reactionToken &&
        candidate.present,
      );
      if (!anotherPresent) set.delete(state.reactionToken);
    }
    reactions.set(state.messageId, set);
  }

  return Object.freeze({
    conversationId,
    title,
    normalizedHistory: Object.freeze(history),
    reactions: Object.freeze(
      Object.fromEntries([...reactions].map(([messageId, values]) => [messageId, Object.freeze([...values].sort())])),
    ),
    reactionStates: Object.freeze([...reactionIdentities.values()].sort(
      (left, right) => left.lastGlobalSequence - right.lastGlobalSequence,
    )),
    agentStatuses: Object.freeze(Object.fromEntries(statuses)),
    eventCount,
    lastGlobalSequence,
  });
}

export function projectProviderHistory(
  events: readonly AuditEvent[],
  conversationId: ConversationId,
): readonly ProviderHistoryRecord[] {
  const history: ProviderHistoryRecord[] = [];
  const pending = new Map<string, PendingAssistant>();
  const seenMessageIds = new Set<string>();

  const addText = (messageId: MessageId, role: "user" | "assistant", text: string) => {
    if (!text || text.length > 8 * 1024 * 1024) {
      throw new ProviderHistoryError("invalid_provider_history");
    }
    if (seenMessageIds.has(messageId)) {
      throw new ProviderHistoryError("duplicate_provider_history_id");
    }
    seenMessageIds.add(messageId);
    history.push(Object.freeze({ kind: "text", messageId, role, text }));
  };

  for (const event of events) {
    if (event.conversationId !== conversationId) continue;
    switch (event.type) {
      case "user.message.accepted": {
        const item = payload(event, "user.message.accepted");
        addText(item.messageId, "user", item.content);
        break;
      }
      case "assistant.stream.started": {
        const item = payload(event, "assistant.stream.started");
        if (pending.has(item.streamId)) {
          throw new ProviderHistoryError("invalid_provider_history");
        }
        pending.set(item.streamId, {
          messageId: item.messageId,
          turnId: item.turnId,
          createdAt: event.timestamp,
          chunks: [],
        });
        break;
      }
      case "assistant.stream.advanced": {
        const item = payload(event, "assistant.stream.advanced");
        const stream = pending.get(item.streamId);
        if (!stream) throw new ProviderHistoryError("invalid_provider_history");
        stream.chunks.push(item.delta);
        break;
      }
      case "tool.proposed":
      case "tool.execution.started":
      case "tool.execution.succeeded":
      case "tool.execution.failed":
      case "tool.execution.uncertain": {
        throw new ProviderHistoryError("incomplete_durable_tool_history");
      }
      case "assistant.stream.completed": {
        const item = payload(event, "assistant.stream.completed");
        const stream = pending.get(item.streamId);
        if (!stream) throw new ProviderHistoryError("invalid_provider_history");
        if (item.stopReason === "tool_pause") {
          throw new ProviderHistoryError("incomplete_durable_tool_history");
        }
        addText(stream.messageId, "assistant", stream.chunks.join(""));
        pending.delete(item.streamId);
        break;
      }
      case "assistant.stream.cancelled": {
        pending.delete(payload(event, "assistant.stream.cancelled").streamId);
        break;
      }
      default:
        break;
    }
  }
  if (history.length === 0) throw new ProviderHistoryError("empty_provider_history");
  return Object.freeze(history);
}

export function assistantTextForTurn(
  events: readonly AuditEvent[],
  conversationId: ConversationId,
  turnId: TurnId,
): string {
  const streams = new Map<string, { chunks: string[]; completedAt?: number; stopReason?: string }>();
  for (const event of events) {
    if (event.conversationId !== conversationId) continue;
    if (event.type === "assistant.stream.started") {
      const item = payload(event, "assistant.stream.started");
      if (item.turnId === turnId) streams.set(item.streamId, { chunks: [] });
      continue;
    }
    if (event.type === "assistant.stream.advanced") {
      const item = payload(event, "assistant.stream.advanced");
      if (item.turnId === turnId) streams.get(item.streamId)?.chunks.push(item.delta);
      continue;
    }
    if (event.type === "assistant.stream.completed") {
      const item = payload(event, "assistant.stream.completed");
      if (item.turnId !== turnId) continue;
      const stream = streams.get(item.streamId);
      if (stream) {
        stream.completedAt = event.globalSequence;
        stream.stopReason = item.stopReason;
      }
    }
  }
  const completed = [...streams.values()]
    .filter((stream) => stream.completedAt !== undefined && stream.stopReason === "complete")
    .sort((left, right) => Number(left.completedAt) - Number(right.completedAt));
  return completed.at(-1)?.chunks.join("") ?? "";
}

export interface ExistingTurn {
  readonly turnId: TurnId;
  readonly status: "completed" | "paused" | "denied" | "failed" | "stopped" | "interrupted";
  readonly reasonCode?: string;
}

export function findExistingTurn(
  events: readonly AuditEvent[],
  conversationId: ConversationId,
  clientRequestId: string,
): ExistingTurn | undefined {
  const accepted = events.find((event) => {
    if (event.conversationId !== conversationId || event.type !== "user.message.accepted") return false;
    return payload(event, "user.message.accepted").clientRequestId === clientRequestId;
  });
  if (!accepted) return undefined;
  const turnId = payload(accepted, "user.message.accepted").turnId;
  const relevant = events.filter(
    (event) => event.conversationId === conversationId && "turnId" in event.payload && event.payload.turnId === turnId,
  );
  const terminal = [...relevant]
    .reverse()
    .find((event) =>
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.stopped" ||
      event.type === "approval.denied"
    );
  if (!terminal) {
    const executionStarted = relevant.some((event) => event.type === "tool.execution.started");
    const executionFinished = relevant.some((event) =>
      ["tool.execution.succeeded", "tool.execution.failed", "tool.execution.uncertain"].includes(event.type),
    );
    const streamStarted = relevant.some((event) => event.type === "assistant.stream.started");
    const toolProposed = relevant.some((event) => event.type === "tool.proposed");
    const pendingControl = [...relevant].reverse().find((event) => event.type === "human.control.requested");
    const steered = [...relevant].reverse().find((event) => event.type === "turn.steered");
    const reasonCode = pendingControl
      ? `interrupted_${(pendingControl.payload as AuditPayloads["human.control.requested"]).controlKind}_requires_reconciliation`
      : steered
        ? "interrupted_steered_phase_requires_resume"
        :
      executionStarted && !executionFinished
        ? "interrupted_execution_requires_reconciliation"
        : toolProposed
          ? "interrupted_tool_turn_requires_resume"
          : streamStarted
            ? "interrupted_stream_requires_resume"
            : "accepted_turn_requires_resume";
    return { turnId, status: "interrupted", reasonCode };
  }
  if (terminal.type === "turn.stopped") {
    return { turnId, status: "stopped", reasonCode: payload(terminal, "turn.stopped").reasonCode };
  }
  if (terminal.type === "turn.failed") {
    return { turnId, status: "failed", reasonCode: payload(terminal, "turn.failed").reasonCode };
  }
  if (terminal.type === "approval.denied") {
    return { turnId, status: "denied", reasonCode: payload(terminal, "approval.denied").reasonCode };
  }
  const status = payload(terminal, "turn.completed").status;
  return { turnId, status };
}
