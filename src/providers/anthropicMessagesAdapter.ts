import type { JsonValue } from "../domain/canonical";
import type {
  ProviderAdapter,
  ProviderAuthoritySnapshot,
  ProviderChunk,
  ProviderId,
  ProviderModelCapabilitySnapshot,
  ProviderTurnRequest,
  ReviewedProviderTool,
} from "../domain/contracts";
import {
  authorizeProviderRequest,
  bindingLeaseIsCurrentForBroker,
  credentialBrokerErrorMatchesInvocation,
  nativeSignalAborted,
  type BrokerStreamResponse,
  type CredentialBrokerInvocationIdentity,
} from "./credentialBroker";
import {
  adapterFailure,
  brokerStreamResponseMatchesInvocation,
  prepareAdapterConfiguration,
  sanitizeProviderAdapterBoundaryError,
  validateProviderTurnRequest,
  type PreparedAdapterConfiguration,
  type ProviderAdapterOptions,
} from "./providerAdapterCommon";
import { encodeAnthropicRequest } from "./providerHistory";
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

export const ANTHROPIC_MESSAGES_PROTOCOL_REVISION = "anthropic-messages-2023-06-01";

interface ActiveBlock {
  readonly index: number;
  readonly kind: "text" | "tool_use";
  readonly text: BoundedTextAccumulator;
  readonly argumentsText: BoundedTextAccumulator;
  toolUseId?: string;
  wireName?: string;
}

function record(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("record required");
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

function safeUnknownEvent(eventName: string, event: Record<string, JsonValue>): boolean {
  if (!/^(?:vendor\.|x[-_.])/.test(eventName)) return false;
  const forbidden = /(message|content|block|tool|argument|model|usage|stop|error|fallback|authority)/i;
  const inspect = (value: JsonValue): boolean => {
    if (Array.isArray(value)) return value.every(inspect);
    if (value && typeof value === "object") {
      return Object.entries(value).every(([key, child]) => !forbidden.test(key) && inspect(child));
    }
    return true;
  };
  return Object.entries(event).every(([key, value]) =>
    ["type", "sequence_number", "metadata"].includes(key) && !forbidden.test(key) && inspect(value));
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

export interface AnthropicMessagesAdapterOptions extends ProviderAdapterOptions {
  readonly maxTokens?: number;
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: readonly ProviderModelCapabilitySnapshot[];
  readonly reviewedTools: readonly ReviewedProviderTool[];
  readonly #config: PreparedAdapterConfiguration;
  readonly #maxTokens: number;

  constructor(options: AnthropicMessagesAdapterOptions) {
    const { maxTokens = 1024, ...common } = options;
    this.#config = prepareAdapterConfiguration(
      "anthropic",
      "anthropic",
      common,
      ANTHROPIC_MESSAGES_PROTOCOL_REVISION,
    );
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000) {
      throw adapterFailure("invalid_adapter_configuration", this.#config, "request-preflight");
    }
    this.#maxTokens = maxTokens;
    this.providerId = this.#config.providerId;
    this.capabilities = this.#config.capabilities;
    this.reviewedTools = this.#config.reviewedTools;
  }

  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderChunk> {
    return this.run(request);
  }

  authoritySnapshot(): ProviderAuthoritySnapshot | undefined {
    if (!bindingLeaseIsCurrentForBroker(this.#config.broker, this.#config.binding)) return undefined;
    return Object.freeze({
      credentialAudience: "anthropic",
      credentialBindingRevision: this.#config.credentialBindingRevision,
    });
  }

  private async *run(request: ProviderTurnRequest): AsyncIterable<ProviderChunk> {
    const prepared = validateProviderTurnRequest(request, this.#config);
    const requestId = prepared.requestId;
    const effectiveTools = prepared.model.toolProposals ? this.reviewedTools : Object.freeze([]);
    const encoded = encodeAnthropicRequest({
      providerId: this.providerId,
      modelId: request.modelId,
      protocolRevision: prepared.model.protocolRevision,
      history: prepared.history,
      tools: effectiveTools,
      limits: this.#config.limits,
      maxTokens: this.#maxTokens,
    });
    const descriptor = {
      binding: this.#config.binding,
      requestId,
      attemptId: prepared.attemptId,
      providerId: this.providerId,
      modelId: request.modelId,
      route: "anthropic_messages" as const,
      canonicalBody: encoded.canonicalBody,
      signal: prepared.signal,
    };
    const invocation: CredentialBrokerInvocationIdentity = Object.freeze({
      requestId,
      attemptId: prepared.attemptId,
      providerId: this.providerId,
      modelId: request.modelId,
      audience: "anthropic",
    });
    authorizeProviderRequest(descriptor);
    let response: BrokerStreamResponse;
    try {
      response = await this.#config.broker.exchange(descriptor);
    } catch (error) {
      if (credentialBrokerErrorMatchesInvocation(error, invocation) && Object.isFrozen(error)) throw error;
      throw adapterFailure("provider_error", this.#config, requestId);
    }
    if (!brokerStreamResponseMatchesInvocation(response, invocation)) {
      throw adapterFailure("provider_error", this.#config, requestId);
    }

    let messageId: string | undefined;
    let activeBlock: ActiveBlock | undefined;
    let nextBlockIndex = 0;
    let terminal = false;
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens = 0;
    let messageDeltaSeen = false;
    let bufferedProposal: Extract<ProviderChunk, { kind: "tool_proposal" }> | undefined;
    const totalText = new BoundedTextAccumulator(
      this.#config.limits.maxTextBytes,
      requestId,
      "anthropic",
    );
    const fail = (reason: Parameters<typeof adapterFailure>[0] = "protocol_violation"): never => {
      throw adapterFailure(reason, this.#config, requestId);
    };

    try {
      for await (const frame of parseSseByteStream(
      response.body,
      this.#config.limits,
      prepared.signal,
      requestId,
      "anthropic",
      (error) => credentialBrokerErrorMatchesInvocation(error, invocation) &&
        error.reasonCode === "secret_reflection_blocked"
        ? "secret_reflection_blocked"
        : undefined,
      )) {
      if (terminal) fail("malformed_order");
      if (frame.kind === "comment") continue;
      if (frame.data === "[DONE]") fail("malformed_order");
      const event = parseEventJson(frame, this.#config.limits, requestId, "anthropic");
      scanDecoded(response, event, this.#config, requestId, invocation);
      const eventName = event.type as string;

      if (eventName === "ping") {
        if (!exactKeys(event, ["type"])) fail("protocol_violation");
        continue;
      }
      if (eventName === "error") {
        try {
          if (!exactKeys(event, ["type", "error"])) fail("protocol_violation");
          const wireError = record(event.error);
          if (!exactKeys(wireError, ["type", "message"]) ||
            typeof wireError.type !== "string" || typeof wireError.message !== "string") {
            fail("protocol_violation");
          }
        } catch {
          fail("protocol_violation");
        }
        fail("provider_error");
      }
      if (eventName === "message_start") {
        if (messageId !== undefined) fail("malformed_order");
        try {
          if (!exactKeys(event, ["type", "message"])) fail("protocol_violation");
          const message = record(event.message);
          if (!exactKeys(message, [
            "id",
            "type",
            "role",
            "model",
            "content",
            "stop_reason",
            "stop_sequence",
            "usage",
          ])) fail("protocol_violation");
          messageId = validateProviderWireId(message.id, this.#config.limits, requestId, "anthropic");
          if (message.type !== "message" || message.model !== request.modelId ||
            message.role !== "assistant" || !Array.isArray(message.content) ||
            message.content.length !== 0 || message.stop_reason !== null ||
            message.stop_sequence !== null) fail("protocol_violation");
          const usage = record(message.usage);
          if (!exactKeys(usage, ["input_tokens", "output_tokens"])) fail("protocol_violation");
          inputTokens = safeInteger(usage.input_tokens);
          outputTokens = safeInteger(usage.output_tokens);
          if (outputTokens !== 0) fail("protocol_violation");
        } catch {
          fail("protocol_violation");
        }
        continue;
      }
      if (messageId === undefined) fail("malformed_order");
      if (eventName === "content_block_start") {
        if (!exactKeys(event, ["type", "index", "content_block"]) ||
          activeBlock || safeInteger(event.index) !== nextBlockIndex) fail("malformed_order");
        const block = record(event.content_block);
        if (block.type !== "text" && block.type !== "tool_use") {
          if (["thinking", "redacted_thinking"].includes(String(block.type))) {
            fail("reasoning_round_trip_unavailable");
          }
          fail("unknown_authority_event");
        }
        const blockKind = block.type as "text" | "tool_use";
        const nextBlock: ActiveBlock = {
          index: nextBlockIndex,
          kind: blockKind,
          text: new BoundedTextAccumulator(this.#config.limits.maxTextBytes, requestId, "anthropic"),
          argumentsText: new BoundedTextAccumulator(
            this.#config.limits.maxToolArgumentBytes,
            requestId,
            "anthropic",
          ),
        };
        activeBlock = nextBlock;
        if (nextBlock.kind === "text") {
          if (!exactKeys(block, ["type", "text"]) || block.text !== "") fail("protocol_violation");
        } else {
          if (!exactKeys(block, ["type", "id", "name", "input"])) fail("protocol_violation");
          if (bufferedProposal) fail("multiple_tool_calls");
          nextBlock.toolUseId = validateProviderWireId(
            block.id,
            this.#config.limits,
            requestId,
            "anthropic",
          );
          nextBlock.wireName = typeof block.name === "string" ? block.name : fail("protocol_violation");
          findReviewedTool(effectiveTools, nextBlock.wireName);
          if (!record(block.input) || Object.keys(record(block.input)).length !== 0) fail("protocol_violation");
        }
        continue;
      }
      if (eventName === "content_block_delta") {
        if (!exactKeys(event, ["type", "index", "delta"]) ||
          !activeBlock || safeInteger(event.index) !== activeBlock.index) fail("malformed_order");
        const block = activeBlock as ActiveBlock;
        const delta = record(event.delta);
        if (block.kind === "text") {
          if (!exactKeys(delta, ["type", "text"]) ||
            delta.type !== "text_delta" || typeof delta.text !== "string") fail("malformed_order");
          const text = delta.text as string;
          block.text.append(text);
          totalText.append(text);
          scanDecoded(response, { normalizedText: totalText.value() }, this.#config, requestId, invocation);
          const released = response.quarantineDecoded("assistant_text", text);
          if (released) yield Object.freeze({ kind: "delta", text: released });
        } else {
          if (!exactKeys(delta, ["type", "partial_json"]) ||
            delta.type !== "input_json_delta" || typeof delta.partial_json !== "string") {
            fail("malformed_order");
          }
          block.argumentsText.append(delta.partial_json);
          scanDecoded(response, { argumentFragment: block.argumentsText.value() }, this.#config, requestId, invocation);
        }
        continue;
      }
      if (eventName === "content_block_stop") {
        if (!exactKeys(event, ["type", "index"]) ||
          !activeBlock || safeInteger(event.index) !== activeBlock.index) fail("malformed_order");
        const block = activeBlock as ActiveBlock;
        if (block.kind === "tool_use") {
          const tool = findReviewedTool(effectiveTools, block.wireName);
          const parsed = parseBoundedToolArguments(
            block.argumentsText.value(),
            this.#config.limits,
            requestId,
            "anthropic",
          );
          const argumentsValue = validateToolArguments(tool, parsed);
          bufferedProposal = Object.freeze({
            kind: "tool_proposal",
            providerItemId: block.toolUseId as string,
            providerCallId: block.toolUseId as string,
            toolId: tool.toolId,
            arguments: argumentsValue,
            summary: `Proposed ${tool.wireName}`,
          });
        }
        activeBlock = undefined;
        nextBlockIndex += 1;
        continue;
      }
      if (eventName === "message_delta") {
        if (!exactKeys(event, ["type", "delta", "usage"]) ||
          activeBlock || messageDeltaSeen) fail("malformed_order");
        const delta = record(event.delta);
        if (!exactKeys(delta, ["stop_reason", "stop_sequence"]) ||
          typeof delta.stop_reason !== "string" ||
          (delta.stop_reason === "stop_sequence"
            ? typeof delta.stop_sequence !== "string" || delta.stop_sequence.length === 0
            : delta.stop_sequence !== null)) {
          fail("protocol_violation");
        }
        stopReason = delta.stop_reason as string;
        const usage = record(event.usage);
        if (!exactKeys(usage, ["output_tokens"])) fail("protocol_violation");
        const latestOutput = safeInteger(usage.output_tokens);
        if (latestOutput < outputTokens) fail("protocol_violation");
        outputTokens = latestOutput;
        messageDeltaSeen = true;
        continue;
      }
      if (eventName === "message_stop") {
        if (!exactKeys(event, ["type"]) ||
          activeBlock || !messageDeltaSeen || terminal) fail("malformed_order");
        if (bufferedProposal ? stopReason !== "tool_use" : stopReason !== "end_turn") {
          fail(stopReason === "refusal" ? "refusal" : "incomplete_response");
        }
        terminal = true;
        continue;
      }
      if (eventName.includes("fallback") || eventName.includes("model")) fail("unknown_authority_event");
      if (safeUnknownEvent(eventName, event)) continue;
      fail("unknown_authority_event");
      }

      if (!terminal || inputTokens === undefined) fail("incomplete_response");
      const finalInputTokens = inputTokens as number;
      if (nativeSignalAborted(prepared.signal)) {
        throw new ProviderStreamBoundaryError("request_cancelled", requestId, "anthropic");
      }
      const trailingText = response.quarantineDecoded("assistant_text", "", true);
      if (trailingText) yield Object.freeze({ kind: "delta", text: trailingText });
      if (nativeSignalAborted(prepared.signal)) {
        throw new ProviderStreamBoundaryError("request_cancelled", requestId, "anthropic");
      }
      const usage: NormalizedProviderUsage = validateProviderUsage({
        inputTokens: finalInputTokens,
        outputTokens,
        totalTokens: finalInputTokens + outputTokens,
      }, requestId, "anthropic");
      scanDecoded(response, usage, this.#config, requestId, invocation);
      yield Object.freeze({ kind: "usage", usage });
      if (nativeSignalAborted(prepared.signal)) {
        throw new ProviderStreamBoundaryError("request_cancelled", requestId, "anthropic");
      }
      if (bufferedProposal) {
        scanDecoded(response, bufferedProposal, this.#config, requestId, invocation);
        yield bufferedProposal;
      } else {
        yield Object.freeze({ kind: "finish" });
      }
    } catch (error) {
      throw sanitizeProviderAdapterBoundaryError(error, this.#config, requestId, invocation);
    }
  }
}
