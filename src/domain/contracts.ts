import type { JsonValue } from "./canonical";

export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type TurnId = Brand<string, "TurnId">;
export type AgentId = Brand<string, "AgentId">;
export type SectionId = Brand<string, "SectionId">;
export type EventId = Brand<string, "EventId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ToolId = Brand<string, "ToolId">;
export type ProposalId = Brand<string, "ProposalId">;
export type GrantId = Brand<string, "GrantId">;
export type ReceiptId = Brand<string, "ReceiptId">;
export type ProviderRequestId = Brand<string, "ProviderRequestId">;
export type ProviderAttemptId = Brand<string, "ProviderAttemptId">;
export type CredentialBindingRevision = Brand<string, "CredentialBindingRevision">;

export function asId<Id extends string>(value: string, label = "identifier"): Id {
  if (!value.trim()) {
    throw new DomainValidationError(`${label} must not be empty`);
  }
  return value as Id;
}

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export type ActorKind = "human" | "agent" | "system" | "provider" | "tool";

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly label?: string;
}

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: string;
}

export interface Conversation {
  readonly id: ConversationId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly createdAt: string;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface NormalizedToolCall {
  readonly proposalId: ProposalId;
  readonly toolId: ToolId;
  readonly argumentsHash: string;
}

export interface NormalizedMessage {
  readonly id: MessageId;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
  readonly toolCall?: NormalizedToolCall;
  readonly receiptId?: ReceiptId;
}

export interface NormalizedProviderTextRecord {
  readonly kind: "text";
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface NormalizedProviderToolExchange {
  readonly kind: "tool_exchange";
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly providerItemId: string;
  readonly providerCallId: string;
  readonly toolId: ToolId;
  readonly arguments: JsonValue;
  readonly result: JsonValue;
  readonly outcome: "succeeded" | "failed";
}

export type ProviderHistoryRecord = NormalizedProviderTextRecord | NormalizedProviderToolExchange;

export type ProviderCapability =
  | "streaming"
  | "tool_proposals"
  | "image_input"
  | "usage"
  | "cancellation"
  | "opaque_reasoning_round_trip";
export type ProviderCredentialAudience = "openai" | "anthropic" | "openrouter";

export interface ProviderModelCapabilitySnapshot {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly streaming: boolean;
  readonly toolProposals: boolean;
  readonly imageInput: boolean;
  readonly usage: boolean;
  readonly cancellation: boolean;
  readonly opaqueReasoningRoundTrip: boolean;
}

export interface ProviderCandidate {
  readonly providerId: ProviderId;
  readonly modelId: string;
}

export interface ProviderSelection {
  readonly candidates: readonly ProviderCandidate[];
  readonly requiredCapabilities: readonly ProviderCapability[];
}

export interface ProviderTurnRequest {
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly directionEpoch?: number;
  readonly providerRequestId: ProviderRequestId;
  readonly providerAttemptId: ProviderAttemptId;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly history: readonly ProviderHistoryRecord[];
  readonly signal: AbortSignal;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ProviderAuthoritySnapshot {
  readonly credentialAudience: ProviderCredentialAudience;
  readonly credentialBindingRevision: CredentialBindingRevision;
}

export type ProviderChunk =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "usage"; readonly usage: ProviderUsage }
  | {
      readonly kind: "tool_proposal";
      readonly providerItemId: string;
      readonly providerCallId: string;
      readonly toolId: ToolId;
      readonly arguments: JsonValue;
      readonly summary: string;
    }
  | { readonly kind: "finish" };

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly reviewedTools: readonly ReviewedProviderTool[];
  authoritySnapshot(): ProviderAuthoritySnapshot | undefined;
  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderChunk>;
}

export type ToolEffect =
  | "pure_compute"
  | "external_read"
  | "write"
  | "delete"
  | "message"
  | "credential"
  | "purchase"
  | "financial"
  | "local_execution"
  | "unknown";

export interface ToolManifest {
  readonly toolId: ToolId;
  readonly version: string;
  readonly schemaHash: string;
  readonly effect: ToolEffect;
  readonly dataScope: readonly string[];
  readonly networkScope: readonly string[];
  readonly idempotency: "idempotent" | "non_idempotent";
  readonly allowPureComputation?: boolean;
}

export interface ReviewedProviderTool {
  readonly toolId: ToolId;
  readonly wireName: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly schemaHash: string;
  readonly manifest: ToolManifest;
}

export interface ReviewedToolAuthority {
  readonly toolId: ToolId;
  readonly schemaHash: string;
  readonly manifestHash: string;
}

export interface PreparedToolProposal {
  readonly proposalId: ProposalId;
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly directionEpoch?: number;
  readonly actor: Actor;
  readonly manifest: ToolManifest;
  readonly arguments: JsonValue;
  readonly argumentsHash: string;
  readonly targetScope: readonly string[];
  readonly summary: string;
  readonly preparedAt: string;
}

export type AuditedToolProposal = Omit<PreparedToolProposal, "arguments">;

export type PolicyOutcome = "allow" | "ask" | "deny";

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly policyVersion: string;
  readonly reasonCode: string;
  readonly decidedAt: string;
}

export interface ApprovalGrant {
  readonly grantId: GrantId;
  readonly proposalFingerprint: string;
  readonly principalId: string;
  readonly proposingActorId: string;
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly directionEpoch?: number;
  readonly stableToolId: ToolId;
  readonly toolSchemaHash: string;
  readonly argumentsHash: string;
  readonly targetScope: readonly string[];
  readonly policyVersion: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly maximumUseCount: 1;
}

export type ExecutionOutcome = "succeeded" | "failed" | "outcome_unknown";

export interface ExecutionReceipt {
  readonly receiptId: ReceiptId;
  readonly proposalId: ProposalId;
  readonly idempotencyKey: string;
  readonly outcome: ExecutionOutcome;
  readonly outputSummary: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface RuntimeBudget {
  readonly maxSteps: number;
  readonly maxCostUnits: number;
  readonly maxDurationMs: number;
}

export type ApprovalDisposition = "granted" | "denied" | "expired" | "consumed";

export const AGENT_COLOR_TOKENS = [
  "relay-cobalt",
  "warm-coral",
  "mineral-mint",
  "graphite-fog",
] as const;
export type AgentColorToken = (typeof AGENT_COLOR_TOKENS)[number];

export const AGENT_MARK_TOKENS = ["orbit", "prism", "signal", "bridge"] as const;
export type AgentMarkToken = (typeof AGENT_MARK_TOKENS)[number];

export const AGENT_STATUSES = [
  "idle",
  "working",
  "waiting_for_human",
  "stopped",
  "error",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const REACTION_TOKENS = ["useful", "clear", "follow_up", "celebrate"] as const;
export type ReactionToken = (typeof REACTION_TOKENS)[number];

export interface AgentProfile {
  readonly id: AgentId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly colorToken: AgentColorToken;
  readonly markToken: AgentMarkToken;
  readonly status: AgentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface WorkspaceSection {
  readonly id: SectionId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly orderKey: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface AgentSectionMembership {
  readonly agentId: AgentId;
  readonly sectionId?: SectionId;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface LegacyProviderSelectedPayload {
  readonly turnId: TurnId;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly fallbackIndex: number;
  readonly directionEpoch?: number;
}

export interface ProviderSelectedV2Payload extends LegacyProviderSelectedPayload {
  readonly protocolRevision: string;
  readonly credentialBindingRevision: CredentialBindingRevision;
  readonly providerRequestId: ProviderRequestId;
}

export interface AuditPayloads {
  "workspace.created": { readonly name: string; readonly createdAt: string };
  "conversation.created": { readonly title: string; readonly createdAt: string };
  "conversation.title.changed": { readonly title: string };
  "message.reaction.changed": {
    readonly messageId: MessageId;
    readonly reaction: string;
    readonly enabled: boolean;
  };
  "agent.status.changed": { readonly agentId: string; readonly status: string };
  "agent.profile.created": {
    readonly agentId: AgentId;
    readonly clientRequestId: string;
    readonly displayName: string;
    readonly roleTitle: string;
    readonly colorToken: AgentColorToken;
    readonly markToken: AgentMarkToken;
    readonly status: AgentStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly revision: number;
  };
  "agent.profile.updated": {
    readonly agentId: AgentId;
    readonly clientRequestId: string;
    readonly expectedRevision: number;
    readonly displayName: string;
    readonly roleTitle: string;
    readonly colorToken: AgentColorToken;
    readonly markToken: AgentMarkToken;
    readonly status: AgentStatus;
    readonly updatedAt: string;
    readonly revision: number;
  };
  "section.created": {
    readonly sectionId: SectionId;
    readonly clientRequestId: string;
    readonly name: string;
    readonly orderKey: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly revision: number;
  };
  "section.renamed": {
    readonly sectionId: SectionId;
    readonly clientRequestId: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly updatedAt: string;
    readonly revision: number;
  };
  "section.reordered": {
    readonly sectionId: SectionId;
    readonly clientRequestId: string;
    readonly expectedRevision: number;
    readonly orderKey: number;
    readonly updatedAt: string;
    readonly revision: number;
  };
  "section.deleted": {
    readonly sectionId: SectionId;
    readonly clientRequestId: string;
    readonly expectedRevision: number;
    readonly revision: number;
    readonly unassignedAgentIds: readonly AgentId[];
    readonly deletedAt: string;
  };
  "agent.section.changed": {
    readonly agentId: AgentId;
    readonly clientRequestId: string;
    readonly expectedRevision: number;
    readonly previousSectionId: SectionId | null;
    readonly sectionId: SectionId | null;
    readonly revision: number;
    readonly changedAt: string;
    readonly reason: "user_assignment" | "section_deleted";
  };
  "reaction.state.set": {
    readonly messageId: MessageId;
    readonly humanActorId: string;
    readonly reactionToken: ReactionToken;
    readonly present: boolean;
    readonly clientRequestId: string;
    readonly setAt: string;
  };
  "user.message.accepted": {
    readonly messageId: MessageId;
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly content: string;
  };
  "provider.selected": LegacyProviderSelectedPayload | ProviderSelectedV2Payload;
  "assistant.stream.started": {
    readonly streamId: string;
    readonly messageId: MessageId;
    readonly turnId: TurnId;
    readonly providerId: ProviderId;
    readonly directionEpoch?: number;
  };
  "assistant.stream.advanced": {
    readonly streamId: string;
    readonly turnId: TurnId;
    readonly delta: string;
    readonly costUnits: number;
    readonly directionEpoch?: number;
  };
  "assistant.stream.completed": {
    readonly streamId: string;
    readonly turnId: TurnId;
    readonly stopReason: "complete" | "tool_pause";
    readonly costUnits?: number;
    readonly directionEpoch?: number;
  };
  "assistant.stream.cancelled": {
    readonly streamId: string;
    readonly turnId: TurnId;
    readonly preservedDeltaCount: number;
    readonly directionEpoch?: number;
  };
  "tool.proposed": {
    readonly turnId: TurnId;
    readonly proposal: AuditedToolProposal;
    readonly proposalFingerprint: string;
    readonly providerId: ProviderId;
  };
  "policy.decided": {
    readonly turnId: TurnId;
    readonly proposalId: ProposalId;
    readonly decision: PolicyDecision;
  };
  "approval.granted": { readonly turnId: TurnId; readonly grant: ApprovalGrant };
  "approval.denied": {
    readonly turnId: TurnId;
    readonly proposalId: ProposalId;
    readonly reasonCode: string;
  };
  "approval.expired": {
    readonly turnId: TurnId;
    readonly proposalId: ProposalId;
    readonly grantId: GrantId;
  };
  "approval.consumed": {
    readonly turnId: TurnId;
    readonly proposalId: ProposalId;
    readonly grantId: GrantId;
  };
  "tool.execution.started": {
    readonly turnId: TurnId;
    readonly proposalId: ProposalId;
    readonly idempotencyKey: string;
    readonly entryPath: ToolEntryPath;
  };
  "tool.execution.succeeded": { readonly turnId: TurnId; readonly receipt: ExecutionReceipt };
  "tool.execution.failed": { readonly turnId: TurnId; readonly receipt: ExecutionReceipt };
  "tool.execution.uncertain": { readonly turnId: TurnId; readonly receipt: ExecutionReceipt };
  "turn.completed": {
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly status: "completed" | "paused" | "denied";
  };
  "turn.failed": {
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly reasonCode: string;
  };
  "human.control.requested": {
    readonly controlId: string;
    readonly controlKind: "stop" | "steer";
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly directionEpoch: number;
    readonly directionHash: string;
    readonly requestedAt: string;
  };
  "direction.accepted": {
    readonly directionId: string;
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly directionEpoch: number;
    readonly kind: "initial" | "steer" | "follow_up";
    readonly messageId: MessageId;
    readonly contentHash: string;
    readonly requestHash?: string;
    readonly acceptedAt: string;
  };
  "turn.stopped": {
    readonly controlId: string;
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly directionEpoch: number;
    readonly reasonCode: "human_stop";
    readonly stoppedAt: string;
  };
  "turn.steered": {
    readonly controlId: string;
    readonly turnId: TurnId;
    readonly clientRequestId: string;
    readonly retiredDirectionEpoch: number;
    readonly nextDirectionEpoch: number;
    readonly directionId: string;
    readonly steeredAt: string;
  };
}

export type AuditEventType = keyof AuditPayloads;

export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  "workspace.created",
  "conversation.created",
  "conversation.title.changed",
  "message.reaction.changed",
  "agent.status.changed",
  "agent.profile.created",
  "agent.profile.updated",
  "section.created",
  "section.renamed",
  "section.reordered",
  "section.deleted",
  "agent.section.changed",
  "reaction.state.set",
  "user.message.accepted",
  "provider.selected",
  "assistant.stream.started",
  "assistant.stream.advanced",
  "assistant.stream.completed",
  "assistant.stream.cancelled",
  "tool.proposed",
  "policy.decided",
  "approval.granted",
  "approval.denied",
  "approval.expired",
  "approval.consumed",
  "tool.execution.started",
  "tool.execution.succeeded",
  "tool.execution.failed",
  "tool.execution.uncertain",
  "turn.completed",
  "turn.failed",
  "human.control.requested",
  "direction.accepted",
  "turn.stopped",
  "turn.steered",
] as const;

export type ToolEntryPath = "direct" | "routed" | "retry" | "resume";

export interface DraftAuditEvent<Type extends AuditEventType = AuditEventType> {
  readonly eventId: EventId;
  readonly workspaceId: WorkspaceId;
  readonly conversationId?: ConversationId;
  readonly actor: Actor;
  readonly timestamp: string;
  readonly payloadSchemaVersion: 1 | 2;
  readonly type: Type;
  readonly payload: AuditPayloads[Type];
}

export interface AuditEvent<Type extends AuditEventType = AuditEventType>
  extends DraftAuditEvent<Type> {
  readonly globalSequence: number;
  readonly previousHash: string;
  readonly currentHash: string;
}

export type NormalizedProviderSelectionEvidence =
  | {
      readonly authorityKind: "legacy_unattested";
      readonly payloadSchemaVersion: 1;
      readonly payload: LegacyProviderSelectedPayload;
    }
  | {
      readonly authorityKind: "attested";
      readonly payloadSchemaVersion: 2;
      readonly payload: ProviderSelectedV2Payload;
    };

export function normalizeProviderSelectionEvidence(
  event: AuditEvent<"provider.selected">,
): NormalizedProviderSelectionEvidence {
  const payload = event.payload;
  if (event.payloadSchemaVersion === 1 && !("protocolRevision" in payload)) {
    return Object.freeze({
      authorityKind: "legacy_unattested",
      payloadSchemaVersion: 1,
      payload,
    });
  }
  if (event.payloadSchemaVersion === 2 &&
    "protocolRevision" in payload &&
    "credentialBindingRevision" in payload &&
    "providerRequestId" in payload) {
    return Object.freeze({
      authorityKind: "attested",
      payloadSchemaVersion: 2,
      payload,
    });
  }
  throw new DomainValidationError("Provider selection schema and payload do not agree");
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface IdSource {
  next(): string;
}
