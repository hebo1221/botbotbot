import { canonicalStringify, type JsonValue } from "../domain/canonical";
import type {
  MessageId,
  ProviderHistoryRecord,
  ProviderId,
  ReviewedProviderTool,
  ToolId,
} from "../domain/contracts";
import { asId } from "../domain/contracts";
import type { CredentialAudience } from "./credentialBroker";
import { BROKER_LIMITS } from "./credentialBroker";
import type { ProviderStreamLimits } from "./providerStream";
import { findReviewedTool, validateToolArguments } from "./reviewedTools";
import { canonicalJsonBytes } from "./strictJson";

export type ProviderHistoryValidationCode =
  | "empty_history"
  | "invalid_history_record"
  | "duplicate_history_id"
  | "broken_history_alternation"
  | "incomplete_tool_exchange"
  | "cross_provider_tool_exchange"
  | "history_too_large";

const PROVIDER_HISTORY_VALIDATION_CODES = new Set<ProviderHistoryValidationCode>([
  "empty_history",
  "invalid_history_record",
  "duplicate_history_id",
  "broken_history_alternation",
  "incomplete_tool_exchange",
  "cross_provider_tool_exchange",
  "history_too_large",
]);

function normalizeProviderHistoryValidationCode(value: unknown): ProviderHistoryValidationCode | undefined {
  return typeof value === "string" &&
      PROVIDER_HISTORY_VALIDATION_CODES.has(value as ProviderHistoryValidationCode)
    ? value as ProviderHistoryValidationCode
    : undefined;
}

export class ProviderHistoryValidationError extends Error {
  readonly retryable = false;
  readonly reasonCode: ProviderHistoryValidationCode;

  constructor(reasonCodeValue: ProviderHistoryValidationCode) {
    const reasonCode = normalizeProviderHistoryValidationCode(reasonCodeValue) ?? "invalid_history_record";
    super(`Provider history validation stopped (${reasonCode}).`);
    this.name = "ProviderHistoryValidationError";
    this.reasonCode = reasonCode;
    Object.freeze(this);
  }
}

export interface ProviderRequestEncoding {
  readonly body: JsonValue;
  readonly canonicalBody: Uint8Array;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalStringify(value)) as JsonValue;
}

function boundedIdentifier(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes;
}

export function validateProviderHistory(input: {
  readonly history: unknown;
  readonly providerId: string;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly tools: readonly ReviewedProviderTool[];
  readonly limits: ProviderStreamLimits;
}): readonly ProviderHistoryRecord[] {
  try {
    if (!Array.isArray(input.history) || input.history.length === 0 || input.history.length > 100_000) {
      throw new ProviderHistoryValidationError("empty_history");
    }
    const result: ProviderHistoryRecord[] = [];
    const seenIds = new Set<string>();
    const seenCalls = new Set<string>();
    let expectedRole: "user" | "assistant" = "user";
    let totalTextBytes = 0;
    for (const raw of input.history) {
      if (!plainRecord(raw) || typeof raw.kind !== "string") {
        throw new ProviderHistoryValidationError("invalid_history_record");
      }
      if (raw.kind === "text") {
        if (!exactKeys(raw, ["kind", "messageId", "role", "text"]) ||
          !boundedIdentifier(raw.messageId, input.limits.maxIdBytes) ||
          (raw.role !== "user" && raw.role !== "assistant") ||
          typeof raw.text !== "string" || raw.text.length === 0 ||
          raw.role !== expectedRole) {
          throw new ProviderHistoryValidationError(
            raw.role !== expectedRole ? "broken_history_alternation" : "invalid_history_record",
          );
        }
        if (seenIds.has(raw.messageId)) throw new ProviderHistoryValidationError("duplicate_history_id");
        const bytes = new TextEncoder().encode(raw.text).byteLength;
        totalTextBytes += bytes;
        if (bytes > input.limits.maxTextBytes || totalTextBytes > input.limits.maxResponseBytes) {
          throw new ProviderHistoryValidationError("history_too_large");
        }
        seenIds.add(raw.messageId);
        result.push(Object.freeze({
          kind: "text",
          messageId: asId<MessageId>(raw.messageId),
          role: raw.role,
          text: raw.text,
        }));
        expectedRole = raw.role === "user" ? "assistant" : "user";
        continue;
      }
      if (raw.kind !== "tool_exchange" || !exactKeys(raw, [
        "kind",
        "providerId",
        "modelId",
        "protocolRevision",
        "providerItemId",
        "providerCallId",
        "toolId",
        "arguments",
        "result",
        "outcome",
      ])) throw new ProviderHistoryValidationError("incomplete_tool_exchange");
      if (expectedRole !== "assistant") {
        throw new ProviderHistoryValidationError("broken_history_alternation");
      }
      if (raw.providerId !== input.providerId || raw.modelId !== input.modelId ||
        raw.protocolRevision !== input.protocolRevision) {
        throw new ProviderHistoryValidationError("cross_provider_tool_exchange");
      }
      if (!boundedIdentifier(raw.providerItemId, input.limits.maxIdBytes) ||
        !boundedIdentifier(raw.providerCallId, input.limits.maxIdBytes) ||
        raw.providerItemId === raw.providerCallId || seenIds.has(raw.providerItemId) ||
        seenCalls.has(raw.providerCallId) || typeof raw.toolId !== "string" ||
        (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
        throw new ProviderHistoryValidationError("incomplete_tool_exchange");
      }
      const tool = input.tools.find((candidate) => candidate.toolId === raw.toolId);
      if (!tool) throw new ProviderHistoryValidationError("incomplete_tool_exchange");
      const argumentsValue = validateToolArguments(tool, raw.arguments as JsonValue);
      const resultValue = cloneJson(raw.result as JsonValue);
      canonicalJsonBytes(argumentsValue, input.limits.maxToolArgumentBytes);
      canonicalJsonBytes(resultValue, input.limits.maxToolArgumentBytes);
      seenIds.add(raw.providerItemId);
      seenCalls.add(raw.providerCallId);
      result.push(Object.freeze({
        kind: "tool_exchange",
        providerId: asId<ProviderId>(raw.providerId),
        modelId: raw.modelId,
        protocolRevision: raw.protocolRevision,
        providerItemId: raw.providerItemId,
        providerCallId: raw.providerCallId,
        toolId: asId<ToolId>(raw.toolId),
        arguments: argumentsValue,
        result: resultValue,
        outcome: raw.outcome,
      }));
      // A tool exchange expands to assistant tool_use/function_call followed by
      // a user tool result, so the next provider-visible role is assistant.
      expectedRole = "assistant";
    }
    if (expectedRole !== "assistant") {
      throw new ProviderHistoryValidationError("broken_history_alternation");
    }
    return Object.freeze(result);
  } catch (error) {
    try {
      if (error instanceof ProviderHistoryValidationError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "reasonCode");
        const reason = descriptor && "value" in descriptor
          ? normalizeProviderHistoryValidationCode(descriptor.value)
          : undefined;
        if (reason) throw new ProviderHistoryValidationError(reason);
      }
    } catch (sanitized) {
      if (sanitized instanceof ProviderHistoryValidationError && Object.isFrozen(sanitized)) throw sanitized;
    }
    throw new ProviderHistoryValidationError("invalid_history_record");
  }
}

function responsesToolDefinition(tool: ReviewedProviderTool): JsonValue {
  return {
    type: "function",
    name: tool.wireName,
    description: tool.description,
    parameters: cloneJson(tool.inputSchema),
    strict: true,
  };
}

function responsesInput(
  history: readonly ProviderHistoryRecord[],
  tools: readonly ReviewedProviderTool[],
): JsonValue[] {
  const result: JsonValue[] = [];
  for (const record of history) {
    if (record.kind === "text") {
      result.push({
        type: "message",
        role: record.role,
        content: [{
          type: record.role === "user" ? "input_text" : "output_text",
          text: record.text,
        }],
      });
      continue;
    }
    const tool = tools.find((candidate) => candidate.toolId === record.toolId);
    if (!tool) throw new ProviderHistoryValidationError("incomplete_tool_exchange");
    result.push({
      type: "function_call",
      id: record.providerItemId,
      call_id: record.providerCallId,
      name: tool.wireName,
      arguments: canonicalStringify(record.arguments),
    });
    result.push({
      type: "function_call_output",
      call_id: record.providerCallId,
      output: canonicalStringify(record.result),
    });
  }
  return result;
}

export function encodeResponsesRequest(input: {
  readonly audience: "openai" | "openrouter";
  readonly providerId: string;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly history: unknown;
  readonly tools: readonly ReviewedProviderTool[];
  readonly limits: ProviderStreamLimits;
}): ProviderRequestEncoding {
  if (!boundedIdentifier(input.modelId, input.limits.maxIdBytes)) {
    throw new ProviderHistoryValidationError("invalid_history_record");
  }
  if (input.audience === "openrouter" && (
    !input.modelId.includes("/") || /(^|[/:_-])(auto|latest)([/:_-]|$)/i.test(input.modelId)
  )) throw new ProviderHistoryValidationError("invalid_history_record");
  const history = validateProviderHistory({ ...input, providerId: input.providerId });
  const body: JsonValue = {
    model: input.modelId,
    input: responsesInput(history, input.tools),
    tools: input.tools.map(responsesToolDefinition),
    stream: true,
    store: false,
    parallel_tool_calls: false,
    tool_choice: input.tools.length === 0 ? "none" : "auto",
    ...(input.audience === "openrouter"
      ? { provider: { allow_fallbacks: false, require_parameters: true } }
      : {}),
  };
  return Object.freeze({
    body,
    canonicalBody: canonicalJsonBytes(body, BROKER_LIMITS.maxRequestBodyBytes),
  });
}

export function encodeAnthropicRequest(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly history: unknown;
  readonly tools: readonly ReviewedProviderTool[];
  readonly limits: ProviderStreamLimits;
  readonly maxTokens: number;
}): ProviderRequestEncoding {
  if (!boundedIdentifier(input.modelId, input.limits.maxIdBytes) ||
    !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 1_000_000) {
    throw new ProviderHistoryValidationError("invalid_history_record");
  }
  const history = validateProviderHistory(input);
  const messages: JsonValue[] = [];
  for (const record of history) {
    if (record.kind === "text") {
      messages.push({ role: record.role, content: [{ type: "text", text: record.text }] });
      continue;
    }
    const tool = findReviewedTool(input.tools, input.tools.find(
      (candidate) => candidate.toolId === record.toolId,
    )?.wireName);
    messages.push({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: record.providerCallId,
        name: tool.wireName,
        input: cloneJson(record.arguments),
      }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: record.providerCallId,
        content: canonicalStringify(record.result),
        ...(record.outcome === "failed" ? { is_error: true } : {}),
      }],
    });
  }
  const body: JsonValue = {
    model: input.modelId,
    messages,
    max_tokens: input.maxTokens,
    tools: input.tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      input_schema: cloneJson(tool.inputSchema),
    })),
    tool_choice: { type: "auto" },
    stream: true,
  };
  return Object.freeze({
    body,
    canonicalBody: canonicalJsonBytes(body, BROKER_LIMITS.maxRequestBodyBytes),
  });
}
