export interface SendMessageRequest {
  readonly conversationId: string;
  readonly clientRequestId: string;
  readonly content: string;
}

export interface DurableMessageReceipt {
  readonly receiptKind: "durable_message_event";
  readonly conversationId: string;
  readonly clientRequestId: string;
  readonly messageId: string;
  readonly globalSequence: number;
}

export interface ConversationControlPort {
  sendMessage(request: SendMessageRequest): Promise<DurableMessageReceipt>;
}

export class InvalidMessageReceiptError extends Error {
  constructor() {
    super("The control service did not return a valid durable message receipt.");
    this.name = "InvalidMessageReceiptError";
  }
}

export function validateMessageReceipt(
  value: unknown,
  request: SendMessageRequest,
): DurableMessageReceipt {
  const receipt = value as Partial<DurableMessageReceipt> | null;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.receiptKind !== "durable_message_event" ||
    receipt.conversationId !== request.conversationId ||
    receipt.clientRequestId !== request.clientRequestId ||
    typeof receipt.messageId !== "string" ||
    receipt.messageId.length === 0 ||
    !Number.isSafeInteger(receipt.globalSequence) ||
    Number(receipt.globalSequence) < 1
  ) {
    throw new InvalidMessageReceiptError();
  }
  return receipt as DurableMessageReceipt;
}
