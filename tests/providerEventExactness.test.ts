import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/domain/canonical";
import {
  asId,
  type ConversationId,
  type MessageId,
  type ProviderAttemptId,
  type ProviderHistoryRecord,
  type ProviderId,
  type ProviderRequestId,
  type ProviderTurnRequest,
  type ReviewedProviderTool,
  type ToolId,
  type ToolManifest,
  type TurnId,
  type WorkspaceId,
} from "../src/domain/contracts";
import {
  AnthropicMessagesAdapter,
  ANTHROPIC_MESSAGES_PROTOCOL_REVISION,
} from "../src/providers/anthropicMessagesAdapter";
import {
  OpenAIResponsesAdapter,
  OPENAI_RESPONSES_PROTOCOL_REVISION,
} from "../src/providers/openAIResponsesAdapter";
import { TestCanaryCredentialBroker } from "./fixtures/canaryCredentialBroker";
import {
  anthropicTextStream,
  anthropicToolStream,
  rawSse,
  responsesTextStream,
  responsesToolStream,
} from "./fixtures/providerStreams";

const MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_MODEL = "gpt-5.4-2026-08-01";
const CANARY = "anthropic-event-exactness-canary-0001";

function reviewedTool(): ReviewedProviderTool {
  const inputSchema = {
    type: "object",
    properties: { text: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["text"],
    additionalProperties: false,
  } as const;
  const schemaHash = canonicalHash(inputSchema);
  const manifest: ToolManifest = {
    toolId: asId<ToolId>("tool.write-note"),
    version: "1.0.0",
    schemaHash,
    effect: "write",
    dataScope: ["workspace/notes"],
    networkScope: [],
    idempotency: "non_idempotent",
  };
  return {
    toolId: manifest.toolId,
    wireName: "write_note",
    description: "Write one reviewed note.",
    inputSchema,
    schemaHash,
    manifest,
  };
}

function turnRequest(): ProviderTurnRequest {
  const history: readonly ProviderHistoryRecord[] = Object.freeze([{
    kind: "text",
    messageId: asId<MessageId>("message_fixture_0001"),
    role: "user",
    text: "hello provider",
  }]);
  return {
    workspaceId: asId<WorkspaceId>("workspace_fixture"),
    conversationId: asId<ConversationId>("conversation_fixture"),
    turnId: asId<TurnId>("turn_fixture"),
    directionEpoch: 1,
    providerRequestId: asId<ProviderRequestId>("prv_exactness_0000000000000001"),
    providerAttemptId: asId<ProviderAttemptId>("att_exactness_000000000000001"),
    providerId: asId<ProviderId>("anthropic"),
    modelId: MODEL,
    history,
    signal: new AbortController().signal,
  };
}

function setup(includeTool = false) {
  const broker = new TestCanaryCredentialBroker();
  const binding = broker.issueCredential("anthropic", CANARY);
  const adapter = new AnthropicMessagesAdapter({
    broker,
    binding,
    capabilities: [{
      providerId: asId<ProviderId>("anthropic"),
      modelId: MODEL,
      protocolRevision: ANTHROPIC_MESSAGES_PROTOCOL_REVISION,
      streaming: true,
      toolProposals: true,
      imageInput: false,
      usage: true,
      cancellation: true,
      opaqueReasoningRoundTrip: false,
    }],
    reviewedTools: includeTool ? [reviewedTool()] : [],
  });
  return { broker, adapter };
}

function mutateEvent(
  stream: string,
  eventType: string,
  mutate: (value: Record<string, any>) => void,
  occurrence = 0,
): string {
  const lines = stream.split("\n");
  let currentEvent = "";
  let seen = 0;
  return lines.map((line) => {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
      return line;
    }
    if (currentEvent === eventType && line.startsWith("data: ")) {
      const value = JSON.parse(line.slice("data: ".length)) as Record<string, any>;
      if (seen === occurrence) mutate(value);
      seen += 1;
      currentEvent = "";
      return `data: ${JSON.stringify(value)}`;
    }
    return line;
  }).join("\n");
}

async function collect(
  adapter: { streamTurn(request: ProviderTurnRequest): AsyncIterable<unknown> },
  request: ProviderTurnRequest = turnRequest(),
): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of adapter.streamTurn(request)) chunks.push(chunk);
  return chunks;
}

function openAiRequest(): ProviderTurnRequest {
  return {
    ...turnRequest(),
    providerRequestId: asId<ProviderRequestId>("prv_openai_exact_00000000000001"),
    providerAttemptId: asId<ProviderAttemptId>("att_openai_exact_0000000000001"),
    providerId: asId<ProviderId>("openai"),
    modelId: OPENAI_MODEL,
  };
}

function setupOpenAi(includeTool = false) {
  const broker = new TestCanaryCredentialBroker();
  const binding = broker.issueCredential("openai", CANARY);
  const adapter = new OpenAIResponsesAdapter({
    broker,
    binding,
    capabilities: [{
      providerId: asId<ProviderId>("openai"),
      modelId: OPENAI_MODEL,
      protocolRevision: OPENAI_RESPONSES_PROTOCOL_REVISION,
      streaming: true,
      toolProposals: true,
      imageInput: false,
      usage: true,
      cancellation: true,
      opaqueReasoningRoundTrip: false,
    }],
    reviewedTools: includeTool ? [reviewedTool()] : [],
  });
  return { broker, adapter };
}

async function expectResponsesRejected(stream: string, includeTool = false): Promise<void> {
  const { broker, adapter } = setupOpenAi(includeTool);
  broker.enqueue({
    audience: "openai",
    route: "openai_responses",
    chunks: [{ bytes: stream }],
  });
  await expect(collect(adapter, openAiRequest())).rejects.toMatchObject({ retryable: false });
}

function withInProgress(stream: string, mutate?: (value: Record<string, any>) => void): string {
  const shifted = stream.replace(/"sequence_number":(\d+)/g, (_match, digits: string) => {
    const sequence = Number(digits);
    return `"sequence_number":${sequence === 0 ? 0 : sequence + 1}`;
  });
  const firstBoundary = shifted.indexOf("\n\n") + 2;
  const inProgress: Record<string, any> = {
    type: "response.in_progress",
    sequence_number: 1,
    response: { id: "resp_fixture_0001", model: OPENAI_MODEL, status: "in_progress" },
  };
  mutate?.(inProgress);
  return `${shifted.slice(0, firstBoundary)}${rawSse("response.in_progress", inProgress)}${shifted.slice(firstBoundary)}`;
}

async function expectRejected(stream: string, includeTool = false, reasonCode?: string): Promise<void> {
  const { broker, adapter } = setup(includeTool);
  broker.enqueue({
    audience: "anthropic",
    route: "anthropic_messages",
    chunks: [{ bytes: stream }],
  });
  const assertion = expect(collect(adapter)).rejects.toMatchObject({ retryable: false });
  await assertion;
  if (reasonCode) await expect(collectFromFresh(stream, includeTool)).rejects.toMatchObject({ reasonCode });
}

async function collectFromFresh(stream: string, includeTool: boolean): Promise<unknown[]> {
  const { broker, adapter } = setup(includeTool);
  broker.enqueue({
    audience: "anthropic",
    route: "anthropic_messages",
    chunks: [{ bytes: stream }],
  });
  return collect(adapter);
}

describe("Anthropic reviewed streaming event inventory", () => {
  it("rejects an unreviewed key on every recognized text-stream event and nested authority object", async () => {
    const base = anthropicTextStream({ model: MODEL });
    const mutations: readonly [string, (value: Record<string, any>) => void, number?][] = [
      ["message_start", (value) => { value.unreviewed = true; }],
      ["message_start", (value) => { value.message.unreviewed = true; }],
      ["message_start", (value) => { value.message.usage.unreviewed = 1; }],
      ["content_block_start", (value) => { value.unreviewed = true; }],
      ["content_block_start", (value) => { value.content_block.unreviewed = true; }],
      ["ping", (value) => { value.unreviewed = true; }],
      ["content_block_delta", (value) => { value.unreviewed = true; }, 0],
      ["content_block_delta", (value) => { value.delta.unreviewed = true; }, 0],
      ["content_block_stop", (value) => { value.unreviewed = true; }],
      ["message_delta", (value) => { value.unreviewed = true; }],
      ["message_delta", (value) => { value.delta.unreviewed = true; }],
      ["message_delta", (value) => { value.usage.unreviewed = true; }],
      ["message_stop", (value) => { value.unreviewed = true; }],
    ];
    for (const [eventType, mutation, occurrence] of mutations) {
      await expectRejected(mutateEvent(base, eventType, mutation, occurrence));
    }
  });

  it("rejects unreviewed keys in both tool-use block shapes before proposal release", async () => {
    const base = anthropicToolStream({ model: MODEL });
    for (const stream of [
      mutateEvent(base, "content_block_start", (value) => { value.content_block.unreviewed = true; }),
      mutateEvent(base, "content_block_delta", (value) => { value.delta.unreviewed = true; }),
    ]) {
      await expectRejected(stream, true);
    }
  });

  it("rejects contradictory initial and terminal lifecycle fields", async () => {
    const base = anthropicTextStream({ model: MODEL });
    for (const stream of [
      mutateEvent(base, "message_start", (value) => { value.message.type = "response"; }),
      mutateEvent(base, "message_start", (value) => { value.message.stop_reason = "end_turn"; }),
      mutateEvent(base, "message_start", (value) => { value.message.stop_sequence = "premature"; }),
      mutateEvent(base, "message_start", (value) => { value.message.usage.output_tokens = 1; }),
      mutateEvent(base, "message_delta", (value) => { value.delta.stop_sequence = "contradiction"; }),
    ]) {
      await expectRejected(stream);
    }
  });

  it("uses an exact error event/error-object inventory before returning the stable provider failure", async () => {
    const valid = rawSse("error", {
      type: "error",
      error: { type: "overloaded_error", message: "discard me" },
    });
    await expectRejected(valid, false, "provider_error");
    await expectRejected(mutateEvent(valid, "error", (value) => { value.unreviewed = true; }), false, "protocol_violation");
    await expectRejected(mutateEvent(valid, "error", (value) => { value.error.unreviewed = true; }), false, "protocol_violation");
  });
});

describe("Responses reviewed streaming event inventory", () => {
  it("rejects an unreviewed key on every recognized text-stream event and nested authority object", async () => {
    const base = responsesTextStream({ model: OPENAI_MODEL, profile: "openai" });
    const mutations: readonly [string, (value: Record<string, any>) => void, number?][] = [
      ["response.created", (value) => { value.unreviewed = true; }],
      ["response.created", (value) => { value.response.unreviewed = true; }],
      ["response.output_item.added", (value) => { value.unreviewed = true; }],
      ["response.output_item.added", (value) => { value.item.unreviewed = true; }],
      ["response.content_part.added", (value) => { value.unreviewed = true; }],
      ["response.content_part.added", (value) => { value.part.unreviewed = true; }],
      ["response.output_text.delta", (value) => { value.unreviewed = true; }, 0],
      ["response.output_text.done", (value) => { value.unreviewed = true; }],
      ["response.content_part.done", (value) => { value.unreviewed = true; }],
      ["response.content_part.done", (value) => { value.part.unreviewed = true; }],
      ["response.output_item.done", (value) => { value.unreviewed = true; }],
      ["response.output_item.done", (value) => { value.item.unreviewed = true; }],
      ["response.output_item.done", (value) => { value.item.content[0].unreviewed = true; }],
      ["response.completed", (value) => { value.unreviewed = true; }],
      ["response.completed", (value) => { value.response.unreviewed = true; }],
      ["response.completed", (value) => { value.response.usage.unreviewed = 1; }],
      ["response.completed", (value) => { value.response.output[0].unreviewed = true; }],
    ];
    for (const [eventType, mutation, occurrence] of mutations) {
      await expectResponsesRejected(mutateEvent(base, eventType, mutation, occurrence));
    }
  });

  it("uses exact inventories for the optional response.in_progress lifecycle event", async () => {
    const base = responsesTextStream({ model: OPENAI_MODEL, profile: "openai" });
    await expectResponsesRejected(withInProgress(base, (value) => { value.unreviewed = true; }));
    await expectResponsesRejected(withInProgress(base, (value) => { value.response.unreviewed = true; }));
  });

  it("rejects unreviewed keys on function-call streaming events and item objects before proposal release", async () => {
    const base = responsesToolStream({ model: OPENAI_MODEL, profile: "openai" });
    const mutations: readonly [string, (value: Record<string, any>) => void, number?][] = [
      ["response.output_item.added", (value) => { value.item.unreviewed = true; }],
      ["response.function_call_arguments.delta", (value) => { value.unreviewed = true; }, 0],
      ["response.function_call_arguments.done", (value) => { value.unreviewed = true; }],
      ["response.output_item.done", (value) => { value.item.unreviewed = true; }],
      ["response.completed", (value) => { value.response.output[0].unreviewed = true; }],
    ];
    for (const [eventType, mutation, occurrence] of mutations) {
      await expectResponsesRejected(mutateEvent(base, eventType, mutation, occurrence), true);
    }
  });

  it("rejects contradictory lifecycle statuses in every successful Responses phase", async () => {
    const base = responsesTextStream({ model: OPENAI_MODEL, profile: "openai" });
    const toolBase = responsesToolStream({ model: OPENAI_MODEL, profile: "openai" });
    for (const [stream, includeTool] of [
      [mutateEvent(base, "response.created", (value) => { value.response.status = "completed"; }), false],
      [withInProgress(base, (value) => { value.response.status = "queued"; }), false],
      [mutateEvent(base, "response.output_item.added", (value) => { value.item.status = "completed"; }), false],
      [mutateEvent(toolBase, "response.output_item.added", (value) => { value.item.status = "completed"; }), true],
      [mutateEvent(base, "response.output_item.done", (value) => { value.item.status = "in_progress"; }), false],
      [mutateEvent(base, "response.completed", (value) => { value.response.status = "in_progress"; }), false],
    ] as const) {
      await expectResponsesRejected(stream, includeTool);
    }
  });
});
