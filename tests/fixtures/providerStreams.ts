function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function done(): string {
  return "data: [DONE]\n\n";
}

export function responsesTextStream(input: {
  readonly model: string;
  readonly profile: "openai" | "openrouter";
  readonly first?: string;
  readonly second?: string;
}): string {
  const first = input.first ?? "hello ";
  const second = input.second ?? "world";
  const responseId = "resp_fixture_0001";
  const itemId = "msg_fixture_0001";
  let sequence = 0;
  const event = (type: string, value: Record<string, unknown>) => sse(type, {
    type,
    sequence_number: sequence++,
    ...value,
  });
  return [
    event("response.created", {
      response: { id: responseId, model: input.model, status: "in_progress" },
    }),
    event("response.output_item.added", {
      output_index: 0,
      item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
    }),
    event("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    event("response.output_text.delta", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: first,
    }),
    event("response.output_text.delta", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: second,
    }),
    event("response.output_text.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: `${first}${second}`,
    }),
    event("response.content_part.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: `${first}${second}` },
    }),
    event("response.output_item.done", {
      output_index: 0,
      item: {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `${first}${second}` }],
      },
    }),
    event("response.completed", {
      response: {
        id: responseId,
        model: input.model,
        status: "completed",
        output: [{
          id: itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `${first}${second}` }],
        }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    }),
    ...(input.profile === "openrouter" ? [done()] : []),
  ].join("");
}

export function responsesToolStream(input: {
  readonly model: string;
  readonly profile: "openai" | "openrouter";
  readonly wireName?: string;
  readonly argumentsText?: string;
  readonly terminal?: "completed" | "failed" | "incomplete";
}): string {
  const responseId = "resp_fixture_tool_0001";
  const itemId = "fc_fixture_item_0001";
  const callId = "call_fixture_0001";
  const wireName = input.wireName ?? "write_note";
  const argumentsText = input.argumentsText ?? "{\"text\":\"hello\"}";
  let sequence = 0;
  const event = (type: string, value: Record<string, unknown>) => sse(type, {
    type,
    sequence_number: sequence++,
    ...value,
  });
  const terminalType = `response.${input.terminal ?? "completed"}`;
  return [
    event("response.created", {
      response: { id: responseId, model: input.model, status: "in_progress" },
    }),
    event("response.output_item.added", {
      output_index: 0,
      item: {
        id: itemId,
        type: "function_call",
        status: "in_progress",
        call_id: callId,
        name: wireName,
        arguments: "",
      },
    }),
    event("response.function_call_arguments.delta", {
      item_id: itemId,
      output_index: 0,
      delta: argumentsText.slice(0, Math.floor(argumentsText.length / 2)),
    }),
    event("response.function_call_arguments.delta", {
      item_id: itemId,
      output_index: 0,
      delta: argumentsText.slice(Math.floor(argumentsText.length / 2)),
    }),
    event("response.function_call_arguments.done", {
      item_id: itemId,
      output_index: 0,
      arguments: argumentsText,
    }),
    event("response.output_item.done", {
      output_index: 0,
      item: {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: wireName,
        arguments: argumentsText,
      },
    }),
    event(terminalType, {
      response: {
        id: responseId,
        model: input.model,
        status: input.terminal ?? "completed",
        output: [{
          id: itemId,
          type: "function_call",
          status: "completed",
          call_id: callId,
          name: wireName,
          arguments: argumentsText,
        }],
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      },
    }),
    ...(input.profile === "openrouter" ? [done()] : []),
  ].join("");
}

export function anthropicTextStream(input: {
  readonly model: string;
  readonly text?: string;
  readonly stopReason?: string;
}): string {
  const text = input.text ?? "hello world";
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_anthropic_0001",
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("ping", { type: "ping" }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, 6) },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(6) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: input.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

export function anthropicToolStream(input: {
  readonly model: string;
  readonly wireName?: string;
  readonly argumentsText?: string;
  readonly stopReason?: string;
}): string {
  const argumentsText = input.argumentsText ?? "{\"text\":\"hello\"}";
  const split = Math.floor(argumentsText.length / 2);
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_anthropic_tool_0001",
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_fixture_0001",
        name: input.wireName ?? "write_note",
        input: {},
      },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: argumentsText.slice(0, split) },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: argumentsText.slice(split) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: input.stopReason ?? "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

export function rawSse(event: string, data: unknown): string {
  return sse(event, data);
}
