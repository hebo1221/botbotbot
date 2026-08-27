import { describe, expect, it } from "vitest";
import { canonicalHash, type JsonValue } from "../src/domain/canonical";
import {
  asId,
  type MessageId,
  type ProviderHistoryRecord,
  type ProviderId,
  type ReviewedProviderTool,
  type ToolId,
  type ToolManifest,
} from "../src/domain/contracts";
import {
  encodeAnthropicRequest,
  encodeResponsesRequest,
  validateProviderHistory,
} from "../src/providers/providerHistory";
import { DEFAULT_PROVIDER_STREAM_LIMITS } from "../src/providers/providerStream";
import {
  prepareReviewedTools,
  validateToolArguments,
} from "../src/providers/reviewedTools";

function tool(overrides: Partial<ReviewedProviderTool> = {}): ReviewedProviderTool {
  const inputSchema = overrides.inputSchema ?? {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 5 },
      label: { type: ["string", "null"], minLength: 1, maxLength: 20 },
    },
    required: ["count", "label"],
    additionalProperties: false,
  };
  const schemaHash = overrides.schemaHash ?? canonicalHash(inputSchema);
  const manifest: ToolManifest = overrides.manifest ?? {
    toolId: asId<ToolId>("tool.reviewed"),
    version: "1.0.0",
    schemaHash,
    effect: "write",
    dataScope: ["workspace/items"],
    networkScope: [],
    idempotency: "idempotent",
  };
  return {
    toolId: manifest.toolId,
    wireName: "reviewed_tool",
    description: "Perform one reviewed operation.",
    inputSchema,
    schemaHash,
    manifest,
    ...overrides,
  };
}

function user(text: string, id = "message_user_0001"): ProviderHistoryRecord {
  return { kind: "text", messageId: asId<MessageId>(id), role: "user", text };
}

function assistant(text: string, id = "message_assistant_0001"): ProviderHistoryRecord {
  return { kind: "text", messageId: asId<MessageId>(id), role: "assistant", text };
}

function exchange(
  providerId = "openai",
  outcome: "succeeded" | "failed" = "succeeded",
): ProviderHistoryRecord {
  return {
    kind: "tool_exchange",
    providerId: asId<ProviderId>(providerId),
    modelId: providerId === "anthropic" ? "claude-exact" : providerId === "openrouter" ? "openai/exact" : "gpt-exact",
    protocolRevision: `${providerId}-v1`,
    providerItemId: "item_provider_0001",
    providerCallId: "call_provider_0001",
    toolId: asId<ToolId>("tool.reviewed"),
    arguments: { count: 2, label: null },
    result: { ok: true, id: "result-1" },
    outcome,
  };
}

describe("deterministic provider history encoders", () => {
  it("maps text-only history deterministically without timestamps, hashes, receipts, or metadata", () => {
    const tools = prepareReviewedTools([]);
    const history = [user("u1"), assistant("a1"), user("u2", "message_user_0002")];
    const openAI = encodeResponsesRequest({
      audience: "openai",
      providerId: "openai",
      modelId: "gpt-exact",
      protocolRevision: "openai-v1",
      history,
      tools,
      limits: DEFAULT_PROVIDER_STREAM_LIMITS,
    });
    expect(openAI.body).toMatchObject({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "u1" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "u2" }] },
      ],
    });
    const serialized = new TextDecoder().decode(openAI.canonicalBody);
    expect(serialized).not.toMatch(/createdAt|receipt|hash|provider.selected|credential/i);
    expect(JSON.parse(serialized)).toEqual(openAI.body);
  });

  it("maps a complete Responses tool exchange with distinct item/call IDs and canonical JSON strings", () => {
    const tools = prepareReviewedTools([tool()]);
    const encoded = encodeResponsesRequest({
      audience: "openai",
      providerId: "openai",
      modelId: "gpt-exact",
      protocolRevision: "openai-v1",
      history: [user("use tool"), exchange("openai")],
      tools,
      limits: DEFAULT_PROVIDER_STREAM_LIMITS,
    });
    expect((encoded.body as { input: unknown[] }).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "use tool" }] },
      {
        type: "function_call",
        id: "item_provider_0001",
        call_id: "call_provider_0001",
        name: "reviewed_tool",
        arguments: '{"count":2,"label":null}',
      },
      {
        type: "function_call_output",
        call_id: "call_provider_0001",
        output: '{"id":"result-1","ok":true}',
      },
    ]);
  });

  it.each(["succeeded", "failed"] as const)(
    "maps Anthropic immediate tool_use/tool_result with outcome %s",
    (outcome) => {
      const tools = prepareReviewedTools([tool()]);
      const encoded = encodeAnthropicRequest({
        providerId: "anthropic",
        modelId: "claude-exact",
        protocolRevision: "anthropic-v1",
        history: [user("use tool"), exchange("anthropic", outcome)],
        tools,
        limits: DEFAULT_PROVIDER_STREAM_LIMITS,
        maxTokens: 1024,
      });
      const messages = (encoded.body as { messages: Array<Record<string, unknown>> }).messages;
      expect(messages[1]).toEqual({
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_provider_0001",
          name: "reviewed_tool",
          input: { count: 2, label: null },
        }],
      });
      expect(messages[2]).toEqual({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_provider_0001",
          content: '{"id":"result-1","ok":true}',
          ...(outcome === "failed" ? { is_error: true } : {}),
        }],
      });
    },
  );

  it("rejects incomplete current durable tool projections instead of synthesizing hashes/summaries", () => {
    const incomplete = [{
      id: "assistant-message",
      role: "assistant",
      content: "",
      createdAt: "2026-08-26T00:00:00.000Z",
      toolCall: {
        proposalId: "proposal-1",
        toolId: "tool.reviewed",
        argumentsHash: "a".repeat(64),
      },
    }];
    expect(() => validateProviderHistory({
      history: incomplete,
      providerId: "openai",
      modelId: "gpt-exact",
      protocolRevision: "openai-v1",
      tools: prepareReviewedTools([tool()]),
      limits: DEFAULT_PROVIDER_STREAM_LIMITS,
    })).toThrowError(expect.objectContaining({ reasonCode: "invalid_history_record" }));
  });

  it.each([
    [[], "empty_history"],
    [[user("")], "invalid_history_record"],
    [[assistant("first")], "broken_history_alternation"],
    [[user("one"), user("two", "message_user_0002")], "broken_history_alternation"],
    [[user("one"), assistant("two", "message_user_0001")], "duplicate_history_id"],
    [[user("one"), exchange("anthropic")], "cross_provider_tool_exchange"],
  ] as const)("rejects malformed history with stable reason %s", (history, reasonCode) => {
    expect(() => validateProviderHistory({
      history,
      providerId: "openai",
      modelId: "gpt-exact",
      protocolRevision: "openai-v1",
      tools: prepareReviewedTools([tool()]),
      limits: DEFAULT_PROVIDER_STREAM_LIMITS,
    })).toThrowError(expect.objectContaining({ reasonCode }));
  });

  it("enforces reviewed schema hashes, strict required fields, unsupported-keyword rejection, and wire collisions", () => {
    expect(() => prepareReviewedTools([tool({ schemaHash: "0".repeat(64) })])).toThrowError(
      expect.objectContaining({ reasonCode: "schema_hash_mismatch" }),
    );
    const optionalSchema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: [],
      additionalProperties: false,
    };
    expect(() => prepareReviewedTools([tool({
      inputSchema: optionalSchema,
      schemaHash: canonicalHash(optionalSchema),
      manifest: { ...tool().manifest, schemaHash: canonicalHash(optionalSchema) },
    })])).toThrowError(expect.objectContaining({ reasonCode: "unsupported_schema" }));
    const refSchema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      $ref: "https://evil.invalid/schema",
    };
    expect(() => prepareReviewedTools([tool({
      inputSchema: refSchema as never,
      schemaHash: canonicalHash(refSchema),
      manifest: { ...tool().manifest, schemaHash: canonicalHash(refSchema) },
    })])).toThrowError(expect.objectContaining({ reasonCode: "unsupported_schema" }));
    expect(() => prepareReviewedTools([
      tool({ wireName: "Collision" }),
      tool({
        toolId: asId<ToolId>("tool.other"),
        wireName: "collision",
        manifest: { ...tool().manifest, toolId: asId<ToolId>("tool.other") },
      }),
    ])).toThrowError(expect.objectContaining({ reasonCode: "tool_name_collision" }));

    const name63 = `A${"b".repeat(62)}`;
    const name64 = `A${"b".repeat(63)}`;
    const name65 = `A${"b".repeat(64)}`;
    expect(() => prepareReviewedTools([tool({ wireName: name63 })])).not.toThrow();
    expect(() => prepareReviewedTools([tool({ wireName: name64 })])).not.toThrow();
    expect(() => prepareReviewedTools([tool({ wireName: name65 })])).toThrowError(
      expect.objectContaining({ reasonCode: "invalid_tool_definition" }),
    );
  });

  it("validates proposal arguments against the same strict reviewed schema", () => {
    const reviewed = prepareReviewedTools([tool()])[0];
    expect(validateToolArguments(reviewed, { count: 2, label: null })).toEqual({ count: 2, label: null });
    for (const invalid of [
      { count: 0, label: null },
      { count: 2 },
      { count: 2, label: null, extra: true },
      { count: 2.5, label: null },
    ]) {
      expect(() => validateToolArguments(reviewed, invalid as JsonValue)).toThrowError(
        expect.objectContaining({ reasonCode: "invalid_tool_arguments" }),
      );
    }
  });

  it("counts Unicode code points and rejects contradictory or type-inconsistent schema literals", () => {
    const makeTool = (inputSchema: any): ReviewedProviderTool => {
      const schemaHash = canonicalHash(inputSchema);
      const base = tool();
      return {
        ...base,
        inputSchema,
        schemaHash,
        manifest: { ...base.manifest, schemaHash },
      };
    };
    const oneCodePoint = {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 1 } },
      required: ["text"],
      additionalProperties: false,
    };
    const reviewed = prepareReviewedTools([makeTool(oneCodePoint)])[0];
    expect(validateToolArguments(reviewed, { text: "🧭" })).toEqual({ text: "🧭" });

    const twoCodePoints = {
      type: "object",
      properties: { text: { type: "string", minLength: 2, maxLength: 2 } },
      required: ["text"],
      additionalProperties: false,
    };
    const requiresTwo = prepareReviewedTools([makeTool(twoCodePoints)])[0];
    expect(() => validateToolArguments(requiresTwo, { text: "🧭" })).toThrowError(
      expect.objectContaining({ reasonCode: "invalid_tool_arguments" }),
    );

    for (const invalidSchema of [
      {
        type: "object",
        properties: { text: { type: "string", minLength: 3, maxLength: 1 } },
        required: ["text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { count: { type: "integer", minimum: 5, maximum: 2 } },
        required: ["count"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { text: { type: "string", enum: [1] } },
        required: ["text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { count: { type: "integer", const: "one" } },
        required: ["count"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { text: { type: "string", minItems: 1 } },
        required: ["text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        minLength: 0,
      },
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        maxItems: 0,
      },
      {
        type: "array",
        items: { type: "string" },
        minLength: 0,
      },
      {
        type: "array",
        items: { type: "number" },
        maximum: 1,
      },
    ]) {
      expect(() => prepareReviewedTools([makeTool(invalidSchema)])).toThrowError(
        expect.objectContaining({ reasonCode: "unsupported_schema" }),
      );
    }
  });

  it("rejects OpenRouter aliases instead of silently routing latest/auto models", () => {
    for (const modelId of ["auto", "openrouter/auto", "openai/latest", "latest/model", "gpt-5.4"]) {
      expect(() => encodeResponsesRequest({
        audience: "openrouter",
        providerId: "openrouter",
        modelId,
        protocolRevision: "openrouter-v1",
        history: [user("hello")],
        tools: [],
        limits: DEFAULT_PROVIDER_STREAM_LIMITS,
      })).toThrowError();
    }
  });
});
