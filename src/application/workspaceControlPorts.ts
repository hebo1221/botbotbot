import type {
  AgentColorToken,
  AgentMarkToken,
  AgentStatus,
  ControlRoomViewModel,
  ReactionToken,
} from "./controlRoomViewModel";

interface WorkspaceRequestBase {
  readonly workspaceId: string;
  readonly humanActorId: string;
  readonly clientRequestId: string;
}

export interface CreateAgentRequest extends WorkspaceRequestBase {
  readonly action: "agent.create";
  readonly agentId: string;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly colorToken: AgentColorToken;
  readonly markToken: AgentMarkToken;
  readonly status: AgentStatus;
}

export interface UpdateAgentRequest extends WorkspaceRequestBase {
  readonly action: "agent.update";
  readonly agentId: string;
  readonly expectedRevision: number;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly colorToken: AgentColorToken;
  readonly markToken: AgentMarkToken;
  readonly status: AgentStatus;
}

export interface CreateSectionRequest extends WorkspaceRequestBase {
  readonly action: "section.create";
  readonly sectionId: string;
  readonly name: string;
  readonly orderKey: number;
}

export interface RenameSectionRequest extends WorkspaceRequestBase {
  readonly action: "section.rename";
  readonly sectionId: string;
  readonly expectedRevision: number;
  readonly name: string;
}

export interface ReorderSectionRequest extends WorkspaceRequestBase {
  readonly action: "section.reorder";
  readonly sectionId: string;
  readonly expectedRevision: number;
  readonly orderKey: number;
}

export interface AssignAgentSectionRequest extends WorkspaceRequestBase {
  readonly action: "section.assign_agent";
  readonly agentId: string;
  readonly expectedMembershipRevision: number;
  readonly sectionId: string | null;
}

export interface DeleteSectionRequest extends WorkspaceRequestBase {
  readonly action: "section.delete";
  readonly sectionId: string;
  readonly expectedRevision: number;
}

export interface SetReactionRequest extends WorkspaceRequestBase {
  readonly action: "reaction.set";
  readonly conversationId: string;
  readonly messageId: string;
  readonly reactionToken: ReactionToken;
  readonly present: boolean;
}

export type WorkspaceControlRequest =
  | CreateAgentRequest
  | UpdateAgentRequest
  | CreateSectionRequest
  | RenameSectionRequest
  | ReorderSectionRequest
  | AssignAgentSectionRequest
  | DeleteSectionRequest
  | SetReactionRequest;

export interface DurableWorkspaceControlReceipt {
  readonly receiptKind: "durable_workspace_control_event";
  readonly request: WorkspaceControlRequest;
  readonly globalSequence: number;
}

export interface StopTurnRequest extends WorkspaceRequestBase {
  readonly action: "turn.stop";
  readonly conversationId: string;
  readonly turnId: string;
  readonly directionEpoch: number;
}

export interface SteerTurnRequest extends WorkspaceRequestBase {
  readonly action: "turn.steer";
  readonly conversationId: string;
  readonly turnId: string;
  readonly directionEpoch: number;
  readonly direction: string;
}

export type TurnControlRequest = StopTurnRequest | SteerTurnRequest;

export interface DurableTurnControlReceipt {
  readonly receiptKind: "durable_turn_control_event";
  readonly request: TurnControlRequest;
  readonly outcome: "stopped" | "steered";
  readonly activeDirectionEpoch: number | null;
  readonly globalSequence: number;
}

export interface WorkspaceControlPort {
  execute(request: WorkspaceControlRequest): Promise<DurableWorkspaceControlReceipt>;
}

export interface TurnControlPort {
  execute(request: TurnControlRequest): Promise<DurableTurnControlReceipt>;
}

export interface ControlRoomViewPort {
  readAfter(request: {
    readonly workspaceId: string;
    readonly humanActorId: string;
    readonly minimumGlobalSequence: number;
  }): Promise<ControlRoomViewModel>;
}

export class InvalidWorkspaceControlReceiptError extends Error {
  constructor() {
    super("The control service did not return a matching durable workspace receipt.");
    this.name = "InvalidWorkspaceControlReceiptError";
  }
}

export class InvalidTurnControlReceiptError extends Error {
  constructor() {
    super("The control service did not return a matching durable turn-control receipt.");
    this.name = "InvalidTurnControlReceiptError";
  }
}

export class InvalidControlRoomSnapshotError extends Error {
  constructor() {
    super("The view service did not return a matching snapshot through the durable receipt sequence.");
    this.name = "InvalidControlRoomSnapshotError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactlyMatches(value: unknown, expected: unknown): boolean {
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value) || Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      Array.isArray(expected) &&
      value.length === expected.length &&
      value.every((item, index) => exactlyMatches(item, expected[index]))
    );
  }
  if (!isPlainObject(value) || !isPlainObject(expected)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actualKeys.every((key) => exactlyMatches(value[key], expected[key]))
  );
}

function isPositiveSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function validateWorkspaceControlReceipt(
  value: unknown,
  request: WorkspaceControlRequest,
): DurableWorkspaceControlReceipt {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 3 ||
    value.receiptKind !== "durable_workspace_control_event" ||
    !exactlyMatches(value.request, request) ||
    !isPositiveSequence(value.globalSequence)
  ) {
    throw new InvalidWorkspaceControlReceiptError();
  }
  return value as unknown as DurableWorkspaceControlReceipt;
}

export function validateTurnControlReceipt(
  value: unknown,
  request: TurnControlRequest,
): DurableTurnControlReceipt {
  const expectedOutcome = request.action === "turn.stop" ? "stopped" : "steered";
  const expectedEpoch = request.action === "turn.stop" ? null : request.directionEpoch + 1;
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 5 ||
    value.receiptKind !== "durable_turn_control_event" ||
    !exactlyMatches(value.request, request) ||
    value.outcome !== expectedOutcome ||
    value.activeDirectionEpoch !== expectedEpoch ||
    !isPositiveSequence(value.globalSequence)
  ) {
    throw new InvalidTurnControlReceiptError();
  }
  return value as unknown as DurableTurnControlReceipt;
}

export function validateRefreshedControlRoom(
  value: unknown,
  workspaceId: string,
  humanActorId: string,
  minimumGlobalSequence: number,
): ControlRoomViewModel {
  const model = value as Partial<ControlRoomViewModel> | null;
  if (
    model === null ||
    typeof model !== "object" ||
    model.workspaceId !== workspaceId ||
    model.currentHumanId !== humanActorId ||
    !Number.isSafeInteger(model.lastGlobalSequence) ||
    Number(model.lastGlobalSequence) < minimumGlobalSequence ||
    !Array.isArray(model.sections) ||
    !Array.isArray(model.agents) ||
    !Array.isArray(model.conversations) ||
    !Array.isArray(model.timeline)
  ) {
    throw new InvalidControlRoomSnapshotError();
  }
  return model as ControlRoomViewModel;
}

async function refreshAfterSequence(
  view: ControlRoomViewPort,
  workspaceId: string,
  humanActorId: string,
  minimumGlobalSequence: number,
): Promise<ControlRoomViewModel> {
  return validateRefreshedControlRoom(
    await view.readAfter({ workspaceId, humanActorId, minimumGlobalSequence }),
    workspaceId,
    humanActorId,
    minimumGlobalSequence,
  );
}

export async function executeWorkspaceControlMutation(
  control: WorkspaceControlPort,
  view: ControlRoomViewPort,
  request: WorkspaceControlRequest,
): Promise<ControlRoomViewModel> {
  const receipt = validateWorkspaceControlReceipt(await control.execute(request), request);
  return refreshAfterSequence(view, request.workspaceId, request.humanActorId, receipt.globalSequence);
}

export async function executeTurnControlMutation(
  control: TurnControlPort,
  view: ControlRoomViewPort,
  request: TurnControlRequest,
): Promise<ControlRoomViewModel> {
  const receipt = validateTurnControlReceipt(await control.execute(request), request);
  return refreshAfterSequence(view, request.workspaceId, request.humanActorId, receipt.globalSequence);
}
