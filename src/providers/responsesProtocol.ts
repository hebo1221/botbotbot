import { canonicalStringify, type JsonValue } from "../domain/canonical";
import type { ProviderChunk, ProviderTurnRequest } from "../domain/contracts";
import {
  authorizeProviderRequest,
  credentialBrokerErrorMatchesInvocation,
  nativeSignalAborted,
  type BrokerStreamResponse,
  type CredentialBrokerInvocationIdentity,
  type ProviderRoute,
} from "./credentialBroker";
import {
  adapterFailure,
  brokerStreamResponseMatchesInvocation,
  sanitizeProviderAdapterBoundaryError,
  validateProviderTurnRequest,
  type PreparedAdapterConfiguration,
} from "./providerAdapterCommon";
import { encodeResponsesRequest } from "./providerHistory";
import {
  BoundedTextAccumulator,
  parseBoundedToolArguments,
  parseEventJson,
  parseSseByteStream,
  validateProviderUsage,
  validateProviderWireId,
  ProviderStreamBoundaryError,
  type NormalizedProviderUsage,
} from "./providerStream";
import { findReviewedTool, validateToolArguments } from "./reviewedTools";

export type ResponsesProfile = "openai" | "openrouter";

interface ResponseItemState {
  readonly outputIndex: number;
  readonly itemId: string;
  readonly kind: "message" | "function_call";
  readonly text: BoundedTextAccumulator;
  readonly argumentsText: BoundedTextAccumulator;
  callId?: string;
  wireName?: string;
  contentStarted: boolean;
  textDone: boolean;
  contentDone: boolean;
  argumentsDone: boolean;
  itemDone: boolean;
  terminalItem?: JsonValue;
}

function record(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record required");
  }
  return value as Record<string, JsonValue>;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("integer required");
  return value as number;
}

function exactKeys(value: Record<string, JsonValue>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  return actual.length === reviewed.length && actual.every((key, index) => key === reviewed[index]);
}

function sameIndex(event: Record<string, JsonValue>, item: ResponseItemState): void {
  let eventItemId = event.item_id;
  if (eventItemId === undefined && event.item !== undefined) {
    eventItemId = record(event.item).id;
  }
  if (eventItemId !== item.itemId || safeInteger(event.output_index) !== item.outputIndex) {
    throw new Error("identity drift");
  }
}

function safeUnknownEvent(eventName: string, event: Record<string, JsonValue>): boolean {
  if (!/^(?:vendor\.|x[-_.])/.test(eventName)) return false;
  const forbidden = /(response|item|content|call|tool|argument|model|usage|stop|status|error|authority|plugin)/i;
  const inspect = (value: JsonValue): boolean => {
    if (Array.isArray(value)) return value.every(inspect);
    if (value && typeof value === "object") {
      return Object.entries(value).every(([key, child]) => !forbidden.test(key) && inspect(child));
    }
    return true;
  };
  return Object.entries(event).every(([key, value]) =>
    ["type", "sequence_number", "metadata"].includes(key) && inspect(value));
}

function scanDecoded(
  response: BrokerStreamResponse,
  value: unknown,
  config: PreparedAdapterConfiguration,
  requestId: string,
  invocation: CredentialBrokerInvocationIdentity,
): void {
  try {
    response.assertCredentialAbsent(value);
  } catch (error) {
    if (credentialBrokerErrorMatchesInvocation(error, invocation) && Object.isFrozen(error)) throw error;
    throw adapterFailure("secret_reflection_blocked", config, requestId);
  }
}

function terminalUsage(value: unknown, requestId: string, config: PreparedAdapterConfiguration): NormalizedProviderUsage {
  try {
    const usage = record(value);
    if (!exactKeys(usage, ["input_tokens", "output_tokens", "total_tokens"])) {
      throw new Error("unreviewed usage field");
    }
    return validateProviderUsage({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    }, requestId, config.audience);
  } catch {
    throw adapterFailure("protocol_violation", config, requestId);
  }
}

export async function* streamResponsesTurn(input: {
  readonly profile: ResponsesProfile;
  readonly route: ProviderRoute;
  readonly config: PreparedAdapterConfiguration;
  readonly request: ProviderTurnRequest;
}): AsyncIterable<ProviderChunk> {
  const prepared = validateProviderTurnRequest(input.request, input.config);
  const requestId = prepared.requestId;
  const effectiveTools = prepared.model.toolProposals ? input.config.reviewedTools : Object.freeze([]);
  const encoded = encodeResponsesRequest({
    audience: input.profile,
    providerId: input.config.providerId,
    modelId: input.request.modelId,
    protocolRevision: prepared.model.protocolRevision,
    history: prepared.history,
    tools: effectiveTools,
    limits: input.config.limits,
  });
  // Re-validate the exact descriptor immediately before crossing the broker
  // boundary; adapters never receive or construct URL/header authority.
  const descriptor = {
    binding: input.config.binding,
    requestId,
    attemptId: prepared.attemptId,
    providerId: input.config.providerId,
    modelId: input.request.modelId,
    route: input.route,
    canonicalBody: encoded.canonicalBody,
    signal: prepared.signal,
  } as const;
  const invocation: CredentialBrokerInvocationIdentity = Object.freeze({
    requestId,
    attemptId: prepared.attemptId,
    providerId: input.config.providerId,
    modelId: input.request.modelId,
    audience: input.config.audience,
  });
  authorizeProviderRequest(descriptor);
  let response: BrokerStreamResponse;
  try {
    response = await input.config.broker.exchange(descriptor);
  } catch (error) {
    if (credentialBrokerErrorMatchesInvocation(error, invocation) && Object.isFrozen(error)) throw error;
    throw adapterFailure("provider_error", input.config, requestId);
  }
  if (!brokerStreamResponseMatchesInvocation(response, invocation)) {
    throw adapterFailure("provider_error", input.config, requestId);
  }

  let responseId: string | undefined;
  let lastSequence = -1;
  let nextOutputIndex = 0;
  let terminal = false;
  let doneCount = 0;
  let terminalUsageValue: NormalizedProviderUsage | undefined;
  let bufferedProposal: Extract<ProviderChunk, { kind: "tool_proposal" }> | undefined;
  const seenItemIds = new Set<string>();
  const seenCallIds = new Set<string>();
  const items = new Map<number, ResponseItemState>();
  const totalText = new BoundedTextAccumulator(
    input.config.limits.maxTextBytes,
    requestId,
    input.config.audience,
  );

  const fail = (reason: Parameters<typeof adapterFailure>[0] = "protocol_violation"): never => {
    throw adapterFailure(reason, input.config, requestId);
  };
  const itemFor = (event: Record<string, JsonValue>): ResponseItemState => {
    const index = safeInteger(event.output_index);
    const item = items.get(index);
    if (!item) return fail("malformed_order");
    sameIndex(event, item);
    return item;
  };

  try {
    for await (const frame of parseSseByteStream(
    response.body,
    input.config.limits,
    prepared.signal,
    requestId,
    input.config.audience,
    (error) => credentialBrokerErrorMatchesInvocation(error, invocation) &&
      error.reasonCode === "secret_reflection_blocked"
      ? "secret_reflection_blocked"
      : undefined,
    )) {
    if (frame.kind === "comment") {
      if (terminal) fail("malformed_order");
      continue;
    }
    if (frame.data === "[DONE]") {
      if (!terminal || frame.event !== undefined || doneCount > 0) fail("malformed_order");
      doneCount += 1;
      continue;
    }
    if (terminal) fail("malformed_order");
    const event = parseEventJson(frame, input.config.limits, requestId, input.config.audience);
    scanDecoded(response, event, input.config, requestId, invocation);
    let sequence = -1;
    try {
      sequence = safeInteger(event.sequence_number);
    } catch {
      fail("protocol_violation");
    }
    if (sequence <= lastSequence) fail("malformed_order");
    lastSequence = sequence;
    const eventName = event.type as string;

    if (eventName === "response.created") {
      if (responseId !== undefined) fail("malformed_order");
      try {
        if (!exactKeys(event, ["type", "sequence_number", "response"])) fail("protocol_violation");
        const responseValue = record(event.response);
        if (!exactKeys(responseValue, ["id", "model", "status"])) fail("protocol_violation");
        responseId = validateProviderWireId(
          responseValue.id,
          input.config.limits,
          requestId,
          input.config.audience,
        );
        if (responseValue.model !== input.request.modelId ||
          (responseValue.status !== "in_progress" && responseValue.status !== "queued")) fail("protocol_violation");
      } catch {
        fail("protocol_violation");
      }
      continue;
    }
    if (responseId === undefined) fail("malformed_order");
    if (eventName === "response.in_progress") {
      if (!exactKeys(event, ["type", "sequence_number", "response"])) fail("protocol_violation");
      const responseValue = record(event.response);
      if (!exactKeys(responseValue, ["id", "model", "status"])) fail("protocol_violation");
      if (responseValue.id !== responseId || responseValue.model !== input.request.modelId ||
        responseValue.status !== "in_progress") fail("protocol_violation");
      continue;
    }
    if (eventName === "response.output_item.added") {
      if (!exactKeys(event, ["type", "sequence_number", "output_index", "item"])) {
        fail("protocol_violation");
      }
      const outputIndex = safeInteger(event.output_index);
      if (outputIndex !== nextOutputIndex || items.has(outputIndex)) fail("malformed_order");
      nextOutputIndex += 1;
      const wireItem = record(event.item);
      const itemId = validateProviderWireId(wireItem.id, input.config.limits, requestId, input.config.audience);
      if (seenItemIds.has(itemId)) fail("duplicate_identity");
      seenItemIds.add(itemId);
      if (wireItem.type !== "message" && wireItem.type !== "function_call") {
        if (wireItem.type === "reasoning") fail("reasoning_round_trip_unavailable");
        fail("unknown_authority_event");
      }
      const itemKind = wireItem.type as "message" | "function_call";
      const state: ResponseItemState = {
        outputIndex,
        itemId,
        kind: itemKind,
        text: new BoundedTextAccumulator(input.config.limits.maxTextBytes, requestId, input.config.audience),
        argumentsText: new BoundedTextAccumulator(
          input.config.limits.maxToolArgumentBytes,
          requestId,
          input.config.audience,
        ),
        contentStarted: false,
        textDone: false,
        contentDone: false,
        argumentsDone: false,
        itemDone: false,
      };
      if (state.kind === "message") {
        if (!exactKeys(wireItem, ["id", "type", "role", "status", "content"]) ||
          wireItem.role !== "assistant" || wireItem.status !== "in_progress" ||
          !Array.isArray(wireItem.content) || wireItem.content.length !== 0) {
          fail("unknown_authority_event");
        }
      } else {
        if (wireItem.status !== "in_progress" ||
          Object.keys(wireItem).sort().join("\u0000") !==
            ["arguments", "call_id", "id", "name", "status", "type"].sort().join("\u0000")) {
          fail("unknown_authority_event");
        }
        state.callId = validateProviderWireId(
          wireItem.call_id,
          input.config.limits,
          requestId,
          input.config.audience,
        );
        state.wireName = typeof wireItem.name === "string" ? wireItem.name : fail("protocol_violation");
        if (state.callId === state.itemId || seenCallIds.has(state.callId)) fail("duplicate_identity");
        seenCallIds.add(state.callId);
        findReviewedTool(effectiveTools, state.wireName);
        if (wireItem.arguments !== "") fail("protocol_violation");
      }
      items.set(outputIndex, state);
      continue;
    }
    if (eventName === "response.content_part.added") {
      if (!exactKeys(event, [
        "type", "sequence_number", "item_id", "output_index", "content_index", "part",
      ])) fail("protocol_violation");
      const item = itemFor(event);
      const part = record(event.part);
      if (item.kind !== "message" || item.contentStarted || safeInteger(event.content_index) !== 0 ||
        !exactKeys(part, ["type", "text"]) ||
        part.type !== "output_text" || part.text !== "") fail("malformed_order");
      item.contentStarted = true;
      continue;
    }
    if (eventName === "response.output_text.delta") {
      if (!exactKeys(event, [
        "type", "sequence_number", "item_id", "output_index", "content_index", "delta",
      ])) fail("protocol_violation");
      const item = itemFor(event);
      if (item.kind !== "message" || !item.contentStarted || item.textDone ||
        safeInteger(event.content_index) !== 0 || typeof event.delta !== "string") fail("malformed_order");
      const delta = event.delta as string;
      item.text.append(delta);
      totalText.append(delta);
      scanDecoded(response, { normalizedText: totalText.value() }, input.config, requestId, invocation);
      const released = response.quarantineDecoded("assistant_text", delta);
      if (released.length > 0) yield Object.freeze({ kind: "delta", text: released });
      continue;
    }
    if (eventName === "response.output_text.done") {
      if (!exactKeys(event, [
        "type", "sequence_number", "item_id", "output_index", "content_index", "text",
      ])) fail("protocol_violation");
      const item = itemFor(event);
      if (item.kind !== "message" || !item.contentStarted || item.textDone ||
        safeInteger(event.content_index) !== 0 || event.text !== item.text.value()) fail("malformed_order");
      item.textDone = true;
      continue;
    }
    if (eventName === "response.content_part.done") {
      if (!exactKeys(event, [
        "type", "sequence_number", "item_id", "output_index", "content_index", "part",
      ])) fail("protocol_violation");
      const item = itemFor(event);
      if (item.kind !== "message" || !item.textDone || item.contentDone ||
        safeInteger(event.content_index) !== 0) fail("malformed_order");
      const part = record(event.part);
      if (!exactKeys(part, ["type", "text"]) ||
        part.type !== "output_text" || part.text !== item.text.value()) fail("protocol_violation");
      item.contentDone = true;
      continue;
    }
    if (eventName === "response.function_call_arguments.delta") {
      if (!exactKeys(event, [
        "type", "sequence_number", "item_id", "output_index", "delta",
      ])) fail("protocol_violation");
      const item = itemFor(event);
      if (item.kind !== "function_call" || item.argumentsDone || typeof event.delta !== "string") {
        fail("malformed_order");
      }
      item.argumentsText.append(event.delta);
      scanDecoded(response, { argumentFragment: item.argumentsText.value() }, input.config, requestId, invocation);
      continue;
    }
    if (eventName === "response.function_call_arguments.done") {
      if (!exactKeys(event, [
        "type", "sequence_number", "item_id", "output_index", "arguments",
      ])) fail("protocol_violation");
      const item = itemFor(event);
      if (item.kind !== "function_call" || item.argumentsDone || event.arguments !== item.argumentsText.value()) {
        fail("malformed_order");
      }
      item.argumentsDone = true;
      continue;
    }
    if (eventName === "response.output_item.done") {
      if (!exactKeys(event, ["type", "sequence_number", "output_index", "item"])) {
        fail("protocol_violation");
      }
      const item = itemFor(event);
      if (item.itemDone) fail("duplicate_identity");
      const wireItem = record(event.item);
      if (wireItem.id !== item.itemId || wireItem.type !== item.kind || wireItem.status !== "completed") {
        fail("protocol_violation");
      }
      if (item.kind === "message") {
        if (!exactKeys(wireItem, ["id", "type", "role", "status", "content"]) ||
          !item.contentDone || wireItem.role !== "assistant" || !Array.isArray(wireItem.content) ||
          wireItem.content.length !== 1) fail("malformed_order");
        const messageContent = wireItem.content as readonly JsonValue[];
        const content = record(messageContent[0]);
        if (!exactKeys(content, ["type", "text"]) ||
          content.type !== "output_text" || content.text !== item.text.value()) {
          fail("protocol_violation");
        }
      } else {
        if (!exactKeys(wireItem, ["id", "type", "status", "call_id", "name", "arguments"]) ||
          !item.argumentsDone || wireItem.call_id !== item.callId || wireItem.name !== item.wireName ||
          wireItem.arguments !== item.argumentsText.value()) fail("protocol_violation");
        if (bufferedProposal) fail("multiple_tool_calls");
        const tool = findReviewedTool(effectiveTools, item.wireName);
        const parsedArguments = parseBoundedToolArguments(
          item.argumentsText.value(),
          input.config.limits,
          requestId,
          input.config.audience,
        );
        const argumentsValue = validateToolArguments(tool, parsedArguments);
        bufferedProposal = Object.freeze({
          kind: "tool_proposal",
          providerItemId: item.itemId,
          providerCallId: item.callId as string,
          toolId: tool.toolId,
          arguments: argumentsValue,
          summary: `Proposed ${tool.wireName}`,
        });
      }
      item.terminalItem = wireItem;
      item.itemDone = true;
      continue;
    }
    if (eventName === "response.completed") {
      if (!exactKeys(event, ["type", "sequence_number", "response"])) fail("protocol_violation");
      if (terminal || [...items.values()].some((item) => !item.itemDone)) fail("malformed_order");
      const responseValue = record(event.response);
      if (!exactKeys(responseValue, ["id", "model", "status", "output", "usage"])) {
        fail("protocol_violation");
      }
      if (responseValue.id !== responseId || responseValue.model !== input.request.modelId ||
        responseValue.status !== "completed") fail("protocol_violation");
      if (!Array.isArray(responseValue.output) || responseValue.output.length !== items.size) {
        fail("protocol_violation");
      }
      const orderedItems = [...items.values()].sort((left, right) => left.outputIndex - right.outputIndex);
      const terminalOutput = responseValue.output as readonly JsonValue[];
      for (let index = 0; index < orderedItems.length; index += 1) {
        if (!orderedItems[index].terminalItem ||
          canonicalStringify(terminalOutput[index]) !== canonicalStringify(orderedItems[index].terminalItem)) {
          fail("protocol_violation");
        }
      }
      terminalUsageValue = terminalUsage(responseValue.usage, requestId, input.config);
      scanDecoded(response, terminalUsageValue, input.config, requestId, invocation);
      terminal = true;
      continue;
    }
    if (eventName === "response.failed" || eventName === "response.incomplete" || eventName === "error") {
      fail(eventName === "response.incomplete" ? "incomplete_response" : "provider_error");
    }
    if (eventName.includes("refusal")) fail("refusal");
    if (eventName.includes("reasoning")) fail("reasoning_round_trip_unavailable");
    if (safeUnknownEvent(eventName, event)) continue;
    fail("unknown_authority_event");
    }

    if (!terminal || !terminalUsageValue) fail("incomplete_response");
    if (input.profile === "openrouter" ? doneCount !== 1 : doneCount > 1) fail("incomplete_response");
    if (nativeSignalAborted(prepared.signal)) {
      throw new ProviderStreamBoundaryError("request_cancelled", requestId, input.config.audience);
    }
    const trailingText = response.quarantineDecoded("assistant_text", "", true);
    if (trailingText) yield Object.freeze({ kind: "delta", text: trailingText });
    if (nativeSignalAborted(prepared.signal)) {
      throw new ProviderStreamBoundaryError("request_cancelled", requestId, input.config.audience);
    }
    const finalUsage = terminalUsageValue as NormalizedProviderUsage;
    yield Object.freeze({ kind: "usage", usage: finalUsage });
    if (nativeSignalAborted(prepared.signal)) {
      throw new ProviderStreamBoundaryError("request_cancelled", requestId, input.config.audience);
    }
    if (bufferedProposal) {
      scanDecoded(response, bufferedProposal, input.config, requestId, invocation);
      yield bufferedProposal;
    } else {
      yield Object.freeze({ kind: "finish" });
    }
  } catch (error) {
    throw sanitizeProviderAdapterBoundaryError(error, input.config, requestId, invocation);
  }
}
