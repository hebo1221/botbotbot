import type {
  AgentColorToken,
  AgentMarkToken,
  AgentStatus,
  ReactionToken,
} from "../domain/contracts";

export type { AgentColorToken, AgentMarkToken, AgentStatus, ReactionToken } from "../domain/contracts";

export type RibbonState = "verified" | "active" | "waiting" | "blocked" | "missing";

export interface DecisionNodeView {
  readonly id: "agent" | "provider" | "policy" | "human" | "receipt";
  readonly label: string;
  readonly value: string;
  readonly state: RibbonState;
  readonly detail: string;
}

export interface ReactionView {
  readonly token: ReactionToken;
  readonly label: string;
  readonly glyph: string;
  readonly count: number;
  readonly presentForCurrentHuman: boolean;
}

export interface TimelineItemView {
  readonly id: string;
  readonly role: "human" | "agent" | "event";
  readonly author: string;
  readonly timestamp: string;
  readonly body: string;
  readonly streamState?: "complete" | "streaming" | "paused";
  readonly decisionNodes?: readonly DecisionNodeView[];
  readonly reactions?: readonly ReactionView[];
}

export interface AgentProfileView {
  readonly id: string;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly colorToken: AgentColorToken;
  readonly markToken: AgentMarkToken;
  readonly status: AgentStatus;
  readonly revision: number;
  readonly membershipRevision: number;
  readonly sectionId?: string;
  readonly activeConversationId?: string;
}

export interface SectionView {
  readonly id: string;
  readonly name: string;
  readonly orderKey: number;
  readonly revision: number;
}

export interface ConversationListItemView {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly unread?: number;
}

export interface ActiveTurnView {
  readonly turnId: string;
  readonly directionEpoch: number;
  readonly state: "running" | "waiting_for_human" | "stopped" | "error";
  readonly connected: boolean;
  readonly disabledReason?: string;
}

export interface ApprovalView {
  readonly proposalId: string;
  readonly action: string;
  readonly scope: string;
  readonly expiresIn: string;
  readonly fingerprint: string;
}

export interface ReceiptSummaryView {
  readonly label: string;
  readonly detail: string;
  readonly globalSequence: number;
}

export interface ControlRoomViewModel {
  readonly workspaceId: string;
  readonly currentHumanId: string;
  readonly workspaceName: string;
  readonly lastGlobalSequence: number;
  readonly sections: readonly SectionView[];
  readonly agents: readonly AgentProfileView[];
  readonly conversations: readonly ConversationListItemView[];
  readonly activeConversationId: string;
  readonly activeTurn?: ActiveTurnView;
  readonly timeline: readonly TimelineItemView[];
  readonly selectedProvider: string;
  readonly providers: readonly string[];
  readonly budget: {
    readonly stepsUsed: number;
    readonly stepsLimit: number;
    readonly costUsed: string;
    readonly timeRemaining: string;
  };
  readonly approval?: ApprovalView;
  readonly lastReceipt?: ReceiptSummaryView;
}
