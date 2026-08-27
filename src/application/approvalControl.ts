export interface ApprovalDecisionRequest {
  readonly proposalId: string;
  readonly disposition: "allow_exact" | "deny";
}

export interface DurableDecisionReceipt {
  readonly receiptKind: "durable_control_event";
  readonly proposalId: string;
  readonly disposition: "allowed" | "denied";
  readonly globalSequence: number;
}

export interface ApprovalControlPort {
  decide(request: ApprovalDecisionRequest): Promise<DurableDecisionReceipt>;
}

export class InvalidDecisionReceiptError extends Error {
  constructor() {
    super("The control service did not return a valid durable decision receipt.");
    this.name = "InvalidDecisionReceiptError";
  }
}

export function validateDecisionReceipt(
  value: unknown,
  proposalId: string,
): DurableDecisionReceipt {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<DurableDecisionReceipt>).receiptKind !== "durable_control_event" ||
    (value as Partial<DurableDecisionReceipt>).proposalId !== proposalId ||
    !["allowed", "denied"].includes(String((value as Partial<DurableDecisionReceipt>).disposition)) ||
    !Number.isSafeInteger((value as Partial<DurableDecisionReceipt>).globalSequence) ||
    Number((value as Partial<DurableDecisionReceipt>).globalSequence) < 1
  ) {
    throw new InvalidDecisionReceiptError();
  }
  return value as DurableDecisionReceipt;
}
