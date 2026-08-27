import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/domain/canonical";
import {
  asId,
  type MessageId,
  type ProviderAttemptId,
  type ProviderHistoryRecord,
  type ProviderId,
  type ProviderModelCapabilitySnapshot,
  type ProviderRequestId,
  type ProviderTurnRequest,
  type ReviewedProviderTool,
  type ToolId,
  type ToolManifest,
  type TurnId,
  type WorkspaceId,
  type ConversationId,
} from "../src/domain/contracts";
import {
  AnthropicMessagesAdapter,
  ANTHROPIC_MESSAGES_PROTOCOL_REVISION,
} from "../src/providers/anthropicMessagesAdapter";
import {
  OpenAIResponsesAdapter,
  OPENAI_RESPONSES_PROTOCOL_REVISION,
} from "../src/providers/openAIResponsesAdapter";
import {
  OpenRouterResponsesAdapter,
  OPENROUTER_RESPONSES_PROTOCOL_REVISION,
} from "../src/providers/openRouterResponsesAdapter";
import {
  ProviderAdapterError,
  type ProviderAdapterOptions,
} from "../src/providers/providerAdapterCommon";
import { CredentialBrokerError } from "../src/providers/credentialBroker";
import { ProviderStreamBoundaryError } from "../src/providers/providerStream";
import { ReviewedToolError } from "../src/providers/reviewedTools";
import {
  FaultingCanaryCredentialBroker,
  TestCanaryCredentialBroker,
  type BrokerResponseFaultTarget,
} from "./fixtures/canaryCredentialBroker";
import {
  anthropicTextStream,
  anthropicToolStream,
  rawSse,
  responsesTextStream,
  responsesToolStream,
} from "./fixtures/providerStreams";

const CANARY = "adapter-canary-never-cross-49f1c420";
const MODELS = Object.freeze({
  openai: "gpt-5.4-2026-08-01",
  anthropic: "claude-sonnet-4-5-20250929",
  openrouter: "openai/gpt-5.4",
});

function capability(
  provider: keyof typeof MODELS,
  overrides: Partial<ProviderModelCapabilitySnapshot> = {},
): ProviderModelCapabilitySnapshot {
  const protocolRevision = provider === "openai"
    ? OPENAI_RESPONSES_PROTOCOL_REVISION
    : provider === "anthropic"
      ? ANTHROPIC_MESSAGES_PROTOCOL_REVISION
      : OPENROUTER_RESPONSES_PROTOCOL_REVISION;
  return {
    providerId: asId<ProviderId>(provider),
    modelId: MODELS[provider],
    protocolRevision,
    streaming: true,
    toolProposals: true,
    imageInput: false,
    usage: true,
    cancellation: true,
    opaqueReasoningRoundTrip: false,
    ...overrides,
  };
}

function reviewedTool(): ReviewedProviderTool {
  const inputSchema = {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 100 },
    },
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

function textHistory(): readonly ProviderHistoryRecord[] {
  return Object.freeze([{
    kind: "text",
    messageId: asId<MessageId>("message_fixture_0001"),
    role: "user",
    text: "hello provider",
  }]);
}

function request(modelId: string, history: readonly ProviderHistoryRecord[] = textHistory()): ProviderTurnRequest {
  const providerId = (Object.entries(MODELS).find(([, model]) => model === modelId)?.[0] ?? "openai") as keyof typeof MODELS;
  return {
    workspaceId: asId<WorkspaceId>("workspace_fixture"),
    conversationId: asId<ConversationId>("conversation_fixture"),
    turnId: asId<TurnId>("turn_fixture"),
    directionEpoch: 1,
    providerRequestId: asId<ProviderRequestId>("prv_000000000000000000000001"),
    providerAttemptId: asId<ProviderAttemptId>("att_000000000000000000000001"),
    providerId: asId<ProviderId>(providerId),
    modelId,
    history,
    signal: new AbortController().signal,
  };
}

async function collect(adapter: { streamTurn(request: ProviderTurnRequest): AsyncIterable<unknown> }, turn: ProviderTurnRequest) {
  const result = [];
  for await (const chunk of adapter.streamTurn(turn)) result.push(chunk);
  return result;
}

function mutateSseJson(
  stream: string,
  eventType: string,
  mutate: (value: Record<string, any>) => void,
): string {
  const lines = stream.split("\n");
  let currentEvent = "";
  return lines.map((line) => {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
      return line;
    }
    if (currentEvent === eventType && line.startsWith("data: ")) {
      const value = JSON.parse(line.slice("data: ".length)) as Record<string, any>;
      mutate(value);
      currentEvent = "";
      return `data: ${JSON.stringify(value)}`;
    }
    return line;
  }).join("\n");
}

function setup(provider: keyof typeof MODELS, tools: readonly ReviewedProviderTool[] = []) {
  const broker = new TestCanaryCredentialBroker();
  const credential = broker.issueCredential(provider, CANARY);
  const options: ProviderAdapterOptions = {
    broker,
    binding: credential,
    capabilities: [capability(provider)],
    reviewedTools: tools,
  };
  const adapter = provider === "openai"
    ? new OpenAIResponsesAdapter(options)
    : provider === "anthropic"
      ? new AnthropicMessagesAdapter(options)
      : new OpenRouterResponsesAdapter(options);
  return { broker, adapter };
}

function poisonError<Value extends Error>(error: Value): Value {
  Object.defineProperties(error, {
    name: { configurable: true, value: `HOSTILE_NAME_${CANARY}` },
    message: { configurable: true, value: `HOSTILE_MESSAGE_${CANARY}` },
    cause: { configurable: true, value: `HOSTILE_CAUSE_${CANARY}` },
    stack: { configurable: true, value: `HOSTILE_STACK_${CANARY}` },
  });
  return error;
}

function hostileBoundaryErrors(provider: keyof typeof MODELS): readonly {
  readonly name: string;
  readonly create: () => unknown;
}[] {
  return [
    {
      name: "forged credential broker error",
      create: () => poisonError(new CredentialBrokerError({
        reasonCode: "secret_reflection_blocked",
        retryable: false,
        audience: provider,
        requestId: "prv_000000000000000000000001",
        statusClass: "request_rejected",
      })),
    },
    {
      name: "mutated stream boundary error",
      create: () => poisonError(new ProviderStreamBoundaryError(
        "cleanup_failed",
        "prv_000000000000000000000001",
        provider,
      )),
    },
    {
      name: "forged adapter error",
      create: () => {
        const error = Object.create(ProviderAdapterError.prototype) as Error;
        Object.defineProperties(error, {
          reasonCode: { configurable: true, value: "refusal" },
          retryable: { configurable: true, value: false },
          audience: { configurable: true, value: provider },
          requestId: { configurable: true, value: "prv_000000000000000000000001" },
        });
        return poisonError(error);
      },
    },
    {
      name: "mutated reviewed-tool error",
      create: () => poisonError(new ReviewedToolError("unadvertised_tool")),
    },
    {
      name: "raw error",
      create: () => poisonError(new Error(CANARY)),
    },
  ];
}

describe("public provider adapters", () => {
  it.each(["openai", "anthropic", "openrouter"] as const)(
    "%s quarantines hostile broker-response method and iterator errors at the direct adapter boundary",
    async (provider) => {
      for (const target of [
        "assertCredentialAbsent",
        "quarantineDecoded",
        "body",
      ] as readonly BrokerResponseFaultTarget[]) {
        for (const fault of hostileBoundaryErrors(provider)) {
          let injected: unknown;
          const broker = new FaultingCanaryCredentialBroker(target, () => {
            injected = fault.create();
            return injected;
          });
          const binding = broker.issueCredential(provider, CANARY);
          const options: ProviderAdapterOptions = {
            broker,
            binding,
            capabilities: [capability(provider)],
          };
          const adapter = provider === "openai"
            ? new OpenAIResponsesAdapter(options)
            : provider === "anthropic"
              ? new AnthropicMessagesAdapter(options)
              : new OpenRouterResponsesAdapter(options);
          broker.enqueue({
            audience: provider,
            route: provider === "openai" ? "openai_responses" :
              provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
            chunks: [{ bytes: provider === "anthropic"
              ? anthropicTextStream({ model: MODELS.anthropic })
              : responsesTextStream({ model: MODELS[provider], profile: provider }) }],
          });
          const observed: unknown[] = [];
          const caught = await (async () => {
            try {
              for await (const chunk of adapter.streamTurn(request(MODELS[provider]))) observed.push(chunk);
            } catch (error) {
              return error;
            }
            return undefined;
          })();
          expect(caught, `${target}: ${fault.name}`).toBeDefined();
          expect(caught, `${target}: ${fault.name}`).not.toBe(injected);
          expect(observed, `${target}: ${fault.name}`).toEqual([]);
          const error = caught as Error & { readonly reasonCode?: unknown; readonly cause?: unknown };
          const observable = JSON.stringify({
            string: String(error),
            name: error.name,
            message: error.message,
            reasonCode: error.reasonCode,
            cause: error.cause,
            stack: error.stack,
            serialized: error,
          });
          expect(observable, `${target}: ${fault.name}`).not.toContain(CANARY);
          expect(() => broker.assertCanaryAbsent(observable), `${target}: ${fault.name}`).not.toThrow();
        }
      }
    },
  );

  it.each(["openai", "anthropic", "openrouter"] as const)(
    "%s streams ordered text, one normalized usage, and one finish",
    async (provider) => {
      const { broker, adapter } = setup(provider);
      const stream = provider === "anthropic"
        ? anthropicTextStream({ model: MODELS[provider] })
        : responsesTextStream({ model: MODELS[provider], profile: provider });
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: stream }],
      });
      const chunks = await collect(adapter, request(MODELS[provider]));
      expect(chunks).toEqual([
        { kind: "delta", text: "hello world" },
        { kind: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        { kind: "finish" },
      ]);
      expect(broker.diagnostics()).toMatchObject({ transportAttemptCount: 1, transportCloseCount: 1 });
      expect(() => broker.assertCanaryAbsent(chunks)).not.toThrow();
    },
  );

  it("emits byte-exact reviewed OpenAI request fields and omits every hosted/stateful field", async () => {
    const { broker, adapter } = setup("openai");
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openai, profile: "openai" }) }],
    });
    await collect(adapter, request(MODELS.openai));
    expect(broker.bodySnapshots()[0]).toEqual({
      input: [{
        content: [{ text: "hello provider", type: "input_text" }],
        role: "user",
        type: "message",
      }],
      model: MODELS.openai,
      parallel_tool_calls: false,
      store: false,
      stream: true,
      tool_choice: "none",
      tools: [],
    });
    expect(JSON.stringify(broker.bodySnapshots()[0])).not.toMatch(
      /previous_response_id|plugin|server_tool|hosted|metadata|reasoning|fallback/i,
    );
  });

  it("emits exact Anthropic Messages fields without thinking, fallbacks, beta, server tools, MCP, or metadata", async () => {
    const { broker, adapter } = setup("anthropic");
    broker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      chunks: [{ bytes: anthropicTextStream({ model: MODELS.anthropic }) }],
    });
    await collect(adapter, request(MODELS.anthropic));
    expect(broker.bodySnapshots()[0]).toEqual({
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hello provider" }] }],
      model: MODELS.anthropic,
      stream: true,
      tool_choice: { type: "auto" },
      tools: [],
    });
    expect(JSON.stringify(broker.bodySnapshots()[0])).not.toMatch(/thinking|fallback|beta|server|mcp|metadata/i);
  });

  it("emits exact OpenRouter stateless policy and no plugins/server tools/provider order/debug metadata", async () => {
    const { broker, adapter } = setup("openrouter");
    broker.enqueue({
      audience: "openrouter",
      route: "openrouter_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openrouter, profile: "openrouter" }) }],
    });
    await collect(adapter, request(MODELS.openrouter));
    expect(broker.bodySnapshots()[0]).toEqual({
      input: [{
        content: [{ text: "hello provider", type: "input_text" }],
        role: "user",
        type: "message",
      }],
      model: MODELS.openrouter,
      parallel_tool_calls: false,
      provider: { allow_fallbacks: false, require_parameters: true },
      store: false,
      stream: true,
      tool_choice: "none",
      tools: [],
    });
    expect(JSON.stringify(broker.bodySnapshots()[0])).not.toMatch(
      /plugins|server_tool|provider_order|debug|trace|metadata|previous_response_id|models/i,
    );
  });

  it.each(["openai", "anthropic", "openrouter"] as const)(
    "%s buffers a complete reviewed tool call until successful terminal validation",
    async (provider) => {
      const tool = reviewedTool();
      const { broker, adapter } = setup(provider, [tool]);
      const stream = provider === "anthropic"
        ? anthropicToolStream({ model: MODELS[provider] })
        : responsesToolStream({ model: MODELS[provider], profile: provider });
      broker.enqueue({
        audience: provider,
        route: provider === "openai" ? "openai_responses" :
          provider === "anthropic" ? "anthropic_messages" : "openrouter_responses",
        chunks: [{ bytes: stream }],
      });
      const chunks = await collect(adapter, request(MODELS[provider]));
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ kind: "usage", usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } });
      expect(chunks[1]).toMatchObject({
        kind: "tool_proposal",
        toolId: tool.toolId,
        arguments: { text: "hello" },
      });
      expect(chunks.some((chunk) => (chunk as { kind: string }).kind === "finish")).toBe(false);
    },
  );

  it.each(["failed", "incomplete"] as const)(
    "OpenAI %s terminal never releases the buffered proposal",
    async (terminal) => {
      const { broker, adapter } = setup("openai", [reviewedTool()]);
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: responsesToolStream({ model: MODELS.openai, profile: "openai", terminal }) }],
      });
      const observed: unknown[] = [];
      const error = await (async () => {
        try {
          for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ retryable: false });
      expect(observed.some((chunk) => (chunk as { kind?: string }).kind === "tool_proposal")).toBe(false);
    },
  );

  it("Anthropic stop-reason disagreement and model fallback both fail without a proposal", async () => {
    const tool = reviewedTool();
    for (const stream of [
      anthropicToolStream({ model: MODELS.anthropic, stopReason: "end_turn" }),
      anthropicToolStream({ model: "different-model" }),
    ]) {
      const { broker, adapter } = setup("anthropic", [tool]);
      broker.enqueue({
        audience: "anthropic",
        route: "anthropic_messages",
        chunks: [{ bytes: stream }],
      });
      const observed: unknown[] = [];
      await expect((async () => {
        for await (const chunk of adapter.streamTurn(request(MODELS.anthropic))) observed.push(chunk);
      })()).rejects.toMatchObject({ retryable: false });
      expect(observed.some((chunk) => (chunk as { kind?: string }).kind === "tool_proposal")).toBe(false);
    }
  });

  it("counts and ignores only vendor-prefixed non-authority events while rejecting authority-changing extensions", async () => {
    const stop = rawSse("message_stop", { type: "message_stop" });
    for (const [metadata, succeeds] of [
      [{ note: "safe extension" }, true],
      [{ model: "silent-substitution" }, false],
    ] as const) {
      const { broker, adapter } = setup("anthropic");
      const extension = rawSse("vendor.notice", { type: "vendor.notice", metadata });
      const stream = anthropicTextStream({ model: MODELS.anthropic }).replace(stop, `${extension}${stop}`);
      broker.enqueue({
        audience: "anthropic",
        route: "anthropic_messages",
        chunks: [{ bytes: stream }],
      });
      const operation = collect(adapter, request(MODELS.anthropic));
      if (succeeds) {
        const result = await operation;
        expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "delta" })]));
      }
      else await expect(operation).rejects.toMatchObject({ retryable: false });
    }
  });

  it("rejects malformed ordering, duplicate/decreasing sequence, and unadvertised tool identity", async () => {
    const malformed = responsesTextStream({ model: MODELS.openai, profile: "openai" })
      .replace('"sequence_number":1', '"sequence_number":0');
    const { broker, adapter } = setup("openai");
    broker.enqueue({ audience: "openai", route: "openai_responses", chunks: [{ bytes: malformed }] });
    await expect(collect(adapter, request(MODELS.openai))).rejects.toMatchObject({ retryable: false });

    const unadvertised = setup("openai", [reviewedTool()]);
    unadvertised.broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesToolStream({
        model: MODELS.openai,
        profile: "openai",
        wireName: "hosted_web_search",
      }) }],
    });
    await expect(collect(unadvertised.adapter, request(MODELS.openai))).rejects.toMatchObject({ retryable: false });
  });

  it("explicitly rejects built-in, hosted, server, plugin, MCP, and custom/free-form tool output", async () => {
    for (const provider of ["openai", "openrouter"] as const) {
      for (const forbiddenType of [
        "web_search_call",
        "hosted_tool_call",
        "server_tool_call",
        "plugin_call",
        "mcp_call",
        "custom_tool_call",
      ]) {
        const { broker, adapter } = setup(provider, [reviewedTool()]);
        const stream = responsesToolStream({ model: MODELS[provider], profile: provider })
          .replaceAll('"function_call"', `"${forbiddenType}"`);
        broker.enqueue({
          audience: provider,
          route: provider === "openai" ? "openai_responses" : "openrouter_responses",
          chunks: [{ bytes: stream }],
        });
        const observed: unknown[] = [];
        await expect((async () => {
          for await (const chunk of adapter.streamTurn(request(MODELS[provider]))) observed.push(chunk);
        })()).rejects.toMatchObject({ retryable: false });
        expect(observed.some((chunk) => (chunk as { kind?: string }).kind === "tool_proposal")).toBe(false);
      }
    }
    for (const forbiddenType of ["server_tool_use", "plugin_tool_use", "mcp_tool_use", "custom_tool_use"]) {
      const { broker, adapter } = setup("anthropic", [reviewedTool()]);
      const stream = anthropicToolStream({ model: MODELS.anthropic })
        .replaceAll('"tool_use"', `"${forbiddenType}"`);
      broker.enqueue({
        audience: "anthropic",
        route: "anthropic_messages",
        chunks: [{ bytes: stream }],
      });
      await expect(collect(adapter, request(MODELS.anthropic))).rejects.toMatchObject({ retryable: false });
    }
  });

  it("requires OpenRouter's single DONE while OpenAI permits zero or one", async () => {
    const missing = setup("openrouter");
    missing.broker.enqueue({
      audience: "openrouter",
      route: "openrouter_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openrouter, profile: "openrouter" })
        .replace("data: [DONE]\n\n", "") }],
    });
    await expect(collect(missing.adapter, request(MODELS.openrouter))).rejects.toMatchObject({ retryable: false });

    const duplicate = setup("openrouter");
    duplicate.broker.enqueue({
      audience: "openrouter",
      route: "openrouter_responses",
      chunks: [{ bytes: `${responsesTextStream({ model: MODELS.openrouter, profile: "openrouter" })}data: [DONE]\n\n` }],
    });
    await expect(collect(duplicate.adapter, request(MODELS.openrouter))).rejects.toMatchObject({ retryable: false });
  });

  it("rejects duplicate success terminals, JSON after terminal, refusal, and provider error without terminal output", async () => {
    for (const suffix of [
      rawSse("response.completed", {
        type: "response.completed",
        sequence_number: 999,
        response: {
          id: "resp_fixture_0001",
          model: MODELS.openai,
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      }),
      rawSse("vendor.after_terminal", {
        type: "vendor.after_terminal",
        sequence_number: 999,
        metadata: { note: "late" },
      }),
    ]) {
      const { broker, adapter } = setup("openai");
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: `${responsesTextStream({ model: MODELS.openai, profile: "openai" })}${suffix}` }],
      });
      await expect(collect(adapter, request(MODELS.openai))).rejects.toMatchObject({ retryable: false });
    }

    const refusal = setup("openai");
    refusal.broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: [
        rawSse("response.created", {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp_refusal_0001", model: MODELS.openai, status: "in_progress" },
        }),
        rawSse("response.refusal.delta", {
          type: "response.refusal.delta",
          sequence_number: 1,
          delta: "refused",
        }),
      ].join("") }],
    });
    await expect(collect(refusal.adapter, request(MODELS.openai))).rejects.toMatchObject({ reasonCode: "refusal" });

    const anthropicError = setup("anthropic");
    anthropicError.broker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      chunks: [{ bytes: rawSse("error", {
        type: "error",
        error: { type: "overloaded_error", message: "discard me" },
      }) }],
    });
    await expect(collect(anthropicError.adapter, request(MODELS.anthropic))).rejects.toMatchObject({
      reasonCode: "provider_error",
      retryable: false,
    });
  });

  it("withholds an already buffered proposal when a later refusal or stream error arrives", async () => {
    const responsesCase = setup("openai", [reviewedTool()]);
    const refused = responsesToolStream({
      model: MODELS.openai,
      profile: "openai",
      terminal: "failed",
    }).replaceAll("response.failed", "response.refusal.done");
    responsesCase.broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: refused }],
    });
    const responseObserved: unknown[] = [];
    await expect((async () => {
      for await (const chunk of responsesCase.adapter.streamTurn(request(MODELS.openai))) {
        responseObserved.push(chunk);
      }
    })()).rejects.toMatchObject({ reasonCode: "refusal", retryable: false });
    expect(responseObserved).toEqual([]);

    const anthropicCase = setup("anthropic", [reviewedTool()]);
    const anthropic = anthropicToolStream({ model: MODELS.anthropic });
    const afterBuffered = anthropic.indexOf("event: message_delta");
    anthropicCase.broker.enqueue({
      audience: "anthropic",
      route: "anthropic_messages",
      chunks: [{ bytes: `${anthropic.slice(0, afterBuffered)}${rawSse("error", {
        type: "error",
        error: { type: "overloaded_error", message: "discard" },
      })}` }],
    });
    const anthropicObserved: unknown[] = [];
    await expect((async () => {
      for await (const chunk of anthropicCase.adapter.streamTurn(request(MODELS.anthropic))) {
        anthropicObserved.push(chunk);
      }
    })()).rejects.toMatchObject({ reasonCode: "provider_error", retryable: false });
    expect(anthropicObserved).toEqual([]);
  });

  it("reconciles terminal Responses inventory and rejects a terminal-added server tool after buffering", async () => {
    const { broker, adapter } = setup("openai", [reviewedTool()]);
    const stream = mutateSseJson(
      responsesToolStream({ model: MODELS.openai, profile: "openai" }),
      "response.completed",
      (value) => {
        value.response.output.push({
          id: "server_tool_terminal_0001",
          type: "server_tool_call",
          status: "completed",
          name: "web_search",
        });
      },
    );
    broker.enqueue({ audience: "openai", route: "openai_responses", chunks: [{ bytes: stream }] });
    const observed: unknown[] = [];
    await expect((async () => {
      for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
    })()).rejects.toMatchObject({ reasonCode: "protocol_violation", retryable: false });
    expect(observed).toEqual([]);
  });

  it.each(["done_role", "done_content", "terminal_content"] as const)(
    "rejects changed Responses message authority at %s",
    async (mutation) => {
      const eventType = mutation === "terminal_content" ? "response.completed" : "response.output_item.done";
      const stream = mutateSseJson(
        responsesTextStream({ model: MODELS.openai, profile: "openai" }),
        eventType,
        (value) => {
          const item = mutation === "terminal_content" ? value.response.output[0] : value.item;
          if (mutation === "done_role") item.role = "user";
          else item.content[0].text = "changed terminal text";
        },
      );
      const { broker, adapter } = setup("openai");
      broker.enqueue({ audience: "openai", route: "openai_responses", chunks: [{ bytes: stream }] });
      await expect(collect(adapter, request(MODELS.openai))).rejects.toMatchObject({ retryable: false });
    },
  );

  it.each(["completed_status", "role_field", "content_field"] as const)(
    "rejects malformed Responses function-call added authority at %s",
    async (mutation) => {
      const stream = mutateSseJson(
        responsesToolStream({ model: MODELS.openai, profile: "openai" }),
        "response.output_item.added",
        (value) => {
          if (mutation === "completed_status") value.item.status = "completed";
          if (mutation === "role_field") value.item.role = "assistant";
          if (mutation === "content_field") value.item.content = [];
        },
      );
      const { broker, adapter } = setup("openai", [reviewedTool()]);
      broker.enqueue({ audience: "openai", route: "openai_responses", chunks: [{ bytes: stream }] });
      const observed: unknown[] = [];
      await expect((async () => {
        for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
      })()).rejects.toMatchObject({ retryable: false });
      expect(observed).toEqual([]);
    },
  );

  it("requires response.in_progress to retain the in-progress lifecycle status", async () => {
    const base = responsesTextStream({ model: MODELS.openai, profile: "openai" });
    const bumped = base.replace(/"sequence_number":(\d+)/g, (_match, raw: string) => {
      const value = Number(raw);
      return `"sequence_number":${value === 0 ? 0 : value + 1}`;
    });
    const insertion = bumped.indexOf("\n\n") + 2;
    const stream = `${bumped.slice(0, insertion)}${rawSse("response.in_progress", {
      type: "response.in_progress",
      sequence_number: 1,
      response: { id: "resp_fixture_0001", model: MODELS.openai, status: "completed" },
    })}${bumped.slice(insertion)}`;
    const { broker, adapter } = setup("openai");
    broker.enqueue({ audience: "openai", route: "openai_responses", chunks: [{ bytes: stream }] });
    await expect(collect(adapter, request(MODELS.openai))).rejects.toMatchObject({ retryable: false });
  });

  it("abort concurrent with completed tool parsing emits zero proposal and closes once", async () => {
    const broker = new TestCanaryCredentialBroker();
    const credential = broker.issueCredential("openai", CANARY);
      const adapter = new OpenAIResponsesAdapter({
        broker,
        binding: credential,
      capabilities: [capability("openai")],
      reviewedTools: [reviewedTool()],
    });
    const stream = responsesToolStream({ model: MODELS.openai, profile: "openai" });
    const terminalAt = stream.indexOf("event: response.completed");
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [
        { bytes: stream.slice(0, terminalAt) },
        { bytes: stream.slice(terminalAt), delayMs: 2_000 },
      ],
    });
    const controller = new AbortController();
    const observed: unknown[] = [];
    const operation = (async () => {
      for await (const chunk of adapter.streamTurn({
        ...request(MODELS.openai),
        signal: controller.signal,
      })) observed.push(chunk);
    })();
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toMatchObject({ retryable: false });
    expect(observed.some((chunk) => (chunk as { kind?: string }).kind === "tool_proposal")).toBe(false);
    expect(broker.diagnostics().transportCloseCount).toBe(1);
  });

  it("abort during delayed post-terminal cleanup emits zero usage/proposal/finish and closes once", async () => {
    const broker = new TestCanaryCredentialBroker();
    const binding = broker.issueCredential("openai", CANARY);
    const adapter = new OpenAIResponsesAdapter({
      broker,
      binding,
      capabilities: [capability("openai")],
      reviewedTools: [reviewedTool()],
    });
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesToolStream({ model: MODELS.openai, profile: "openai" }) }],
      cleanupDelayMs: 100,
    });
    const controller = new AbortController();
    const observed: unknown[] = [];
    const operation = (async () => {
      for await (const chunk of adapter.streamTurn({
        ...request(MODELS.openai),
        signal: controller.signal,
      })) observed.push(chunk);
    })();
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toMatchObject({ reasonCode: "request_cancelled", retryable: false });
    expect(observed).toEqual([]);
    expect(broker.diagnostics().transportCloseCount).toBe(1);
  });

  it("rejects duplicate-key and schema-invalid fragmented arguments before proposal emission", async () => {
    for (const argumentsText of ['{"text":"one","text":"two"}', '{"other":"value"}']) {
      const { broker, adapter } = setup("anthropic", [reviewedTool()]);
      broker.enqueue({
        audience: "anthropic",
        route: "anthropic_messages",
        chunks: [{ bytes: anthropicToolStream({ model: MODELS.anthropic, argumentsText }) }],
      });
      await expect(collect(adapter, request(MODELS.anthropic))).rejects.toMatchObject({ retryable: false });
    }
  });

  it("fails capability/model preflight before broker activity and exposes deep-frozen non-secret snapshots", async () => {
    const { broker, adapter } = setup("openai");
    expect(Object.isFrozen(adapter.capabilities)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities[0])).toBe(true);
    expect(JSON.stringify(adapter)).not.toContain(CANARY);
    expect(JSON.stringify(adapter)).not.toContain("cred_");
    expect(JSON.stringify(adapter)).not.toContain("binding_");
    await expect(collect(adapter, request("unknown-model"))).rejects.toMatchObject({
      reasonCode: "unsupported_model",
    });
    expect(broker.diagnostics().transportAttemptCount).toBe(0);
  });

  it("pins protocol revisions and rejects capability claims inconsistent with implemented behavior", () => {
    const inconsistent: Partial<ProviderModelCapabilitySnapshot>[] = [
      { protocolRevision: "caller-invented-revision" },
      { streaming: false },
      { usage: false },
      { cancellation: false },
      { imageInput: true },
      { opaqueReasoningRoundTrip: true },
    ];
    for (const override of inconsistent) {
      const broker = new TestCanaryCredentialBroker();
      const binding = broker.issueCredential("openai", CANARY);
      expect(() => new OpenAIResponsesAdapter({
        broker,
        binding,
        capabilities: [capability("openai", override)],
      })).toThrowError(expect.objectContaining({ reasonCode: "invalid_adapter_configuration" }));
      expect(broker.diagnostics().transportAttemptCount).toBe(0);
    }
  });

  it("rejects transferring a broker-owned binding lease to a different broker", () => {
    const issuer = new TestCanaryCredentialBroker();
    const otherBroker = new TestCanaryCredentialBroker();
    const binding = issuer.issueCredential("openai", CANARY);
    expect(() => new OpenAIResponsesAdapter({
      broker: otherBroker,
      binding,
      capabilities: [capability("openai")],
    })).toThrowError(expect.objectContaining({ reasonCode: "invalid_adapter_configuration" }));
    expect(issuer.diagnostics().transportAttemptCount).toBe(0);
    expect(otherBroker.diagnostics().transportAttemptCount).toBe(0);
  });

  it("omits tools and rejects tool output when the selected model capability disables proposals", async () => {
    const reviewed = reviewedTool();
    for (const emitsTool of [false, true]) {
      const broker = new TestCanaryCredentialBroker();
      const credential = broker.issueCredential("openai", CANARY);
      const adapter = new OpenAIResponsesAdapter({
        broker,
        binding: credential,
        capabilities: [capability("openai", { toolProposals: false })],
        reviewedTools: [reviewed],
      });
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: emitsTool
          ? responsesToolStream({ model: MODELS.openai, profile: "openai" })
          : responsesTextStream({ model: MODELS.openai, profile: "openai" }) }],
      });
      const operation = collect(adapter, request(MODELS.openai));
      if (emitsTool) await expect(operation).rejects.toMatchObject({ retryable: false });
      else {
        await expect(operation).resolves.toBeTruthy();
        expect(broker.bodySnapshots()[0]).toMatchObject({ tools: [], tool_choice: "none" });
      }
    }
  });

  it("blocks a credential reconstructed across normalized text deltas before the suffix is emitted", async () => {
    const { broker, adapter } = setup("openai");
    const split = Math.floor(CANARY.length / 2);
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({
        model: MODELS.openai,
        profile: "openai",
        first: CANARY.slice(0, split),
        second: CANARY.slice(split),
      }) }],
    });
    const observed: unknown[] = [];
    const error = await (async () => {
      try {
        for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ reasonCode: "secret_reflection_blocked", retryable: false });
    expect(JSON.stringify(observed)).not.toContain(CANARY);
    expect(observed).toEqual([]);
  });

  it("holds back every N-1 decoded prefix across all JSON-escaped canary split positions", async () => {
    const escapedJson = (value: any): string => {
      if (typeof value === "string") {
        return `"${[...value].map((character) =>
          `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")}"`;
      }
      if (Array.isArray(value)) return `[${value.map(escapedJson).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.entries(value).map(([key, item]) =>
          `${escapedJson(key)}:${escapedJson(item)}`).join(",")}}`;
      }
      return JSON.stringify(value);
    };
    for (let split = 1; split < CANARY.length; split += 1) {
      const first = CANARY.slice(0, split);
      const second = CANARY.slice(split);
      let stream = responsesTextStream({
        model: MODELS.openai,
        profile: "openai",
        first,
        second,
      });
      stream = stream.split("\n").map((line) => line.startsWith("data: {")
        ? `data: ${escapedJson(JSON.parse(line.slice("data: ".length)))}`
        : line).join("\n");
      const { broker, adapter } = setup("openai");
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: stream }],
      });
      const observed: unknown[] = [];
      const error = await (async () => {
        try {
          for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ reasonCode: "secret_reflection_blocked", retryable: false });
      expect(observed).toEqual([]);
      expect(JSON.stringify({ observed, error })).not.toContain(CANARY);
    }
  });

  it.each(["provider_error", "provider_id"] as const)(
    "blocks a credential canary reflected through %s before any normalized value",
    async (location) => {
      const { broker, adapter } = setup("openai");
      const stream = location === "provider_error"
        ? [
            rawSse("response.created", {
              type: "response.created",
              sequence_number: 0,
              response: { id: "resp_error_0001", model: MODELS.openai, status: "in_progress" },
            }),
            rawSse("error", {
              type: "error",
              sequence_number: 1,
              error: { code: "server_error", message: CANARY },
            }),
          ].join("")
        : responsesTextStream({ model: MODELS.openai, profile: "openai" })
          .replaceAll("resp_fixture_0001", CANARY);
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [{ bytes: stream }],
      });
      const observed: unknown[] = [];
      const error = await (async () => {
        try {
          for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ reasonCode: "secret_reflection_blocked", retryable: false });
      expect(observed).toEqual([]);
      expect(JSON.stringify(error)).not.toContain(CANARY);
    },
  );

  it("blocks a JSON-escaped credential in tool-argument channels before model/tool proposal output", async () => {
    const escapedJson = (value: any): string => {
      if (typeof value === "string") {
        return `"${[...value].map((character) =>
          `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")}"`;
      }
      if (Array.isArray(value)) return `[${value.map(escapedJson).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.entries(value).map(([key, item]) =>
          `${escapedJson(key)}:${escapedJson(item)}`).join(",")}}`;
      }
      return JSON.stringify(value);
    };
    let stream = responsesToolStream({
      model: MODELS.openai,
      profile: "openai",
      argumentsText: JSON.stringify({ text: CANARY }),
    });
    stream = stream.split("\n").map((line) => line.startsWith("data: {")
      ? `data: ${escapedJson(JSON.parse(line.slice("data: ".length)))}`
      : line).join("\n");
    const { broker, adapter } = setup("openai", [reviewedTool()]);
    broker.enqueue({ audience: "openai", route: "openai_responses", chunks: [{ bytes: stream }] });
    const observed: unknown[] = [];
    const error = await (async () => {
      try {
        for await (const chunk of adapter.streamTurn(request(MODELS.openai))) observed.push(chunk);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ reasonCode: "secret_reflection_blocked", retryable: false });
    expect(observed).toEqual([]);
    expect(JSON.stringify({ observed, error })).not.toContain(CANARY);
  });

  it("aborts a stalled stream promptly, closes once, and emits no late normalized chunk", async () => {
    const broker = new TestCanaryCredentialBroker();
    const credential = broker.issueCredential("openai", CANARY);
    const adapter = new OpenAIResponsesAdapter({
      broker,
      binding: credential,
      capabilities: [capability("openai")],
    });
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openai, profile: "openai" }), delayMs: 2_000 }],
    });
    const controller = new AbortController();
    const turn = { ...request(MODELS.openai), signal: controller.signal };
    const started = Date.now();
    const pending = collect(adapter, turn);
    setTimeout(() => controller.abort("secret abort reason"), 10);
    await expect(pending).rejects.toMatchObject({ retryable: false });
    expect(Date.now() - started).toBeLessThan(500);
    expect(broker.diagnostics().transportCloseCount).toBe(1);
  });

  it("aborts during response headers with zero normalized output and one transport close", async () => {
    const broker = new TestCanaryCredentialBroker();
    const credential = broker.issueCredential("openai", CANARY);
    const adapter = new OpenAIResponsesAdapter({
      broker,
      binding: credential,
      capabilities: [capability("openai")],
    });
    broker.enqueue({
      audience: "openai",
      route: "openai_responses",
      headerDelayMs: 2_000,
      chunks: [{ bytes: responsesTextStream({ model: MODELS.openai, profile: "openai" }) }],
    });
    const controller = new AbortController();
    const observed: unknown[] = [];
    const operation = (async () => {
      for await (const chunk of adapter.streamTurn({
        ...request(MODELS.openai),
        signal: controller.signal,
      })) observed.push(chunk);
    })();
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toMatchObject({ retryable: false });
    expect(observed).toEqual([]);
    expect(broker.diagnostics().transportCloseCount).toBe(1);
  });

  it.each(["utf8", "json"] as const)(
    "aborts across a split %s token without replacement text, proposal, or late output",
    async (splitKind) => {
      const broker = new TestCanaryCredentialBroker();
      const credential = broker.issueCredential("openai", CANARY);
      const adapter = new OpenAIResponsesAdapter({
        broker,
        binding: credential,
        capabilities: [capability("openai")],
      });
      const stream = responsesTextStream({
        model: MODELS.openai,
        profile: "openai",
        first: "안녕 ",
        second: "world",
      });
      const encoded = new TextEncoder().encode(stream);
      let split: number;
      if (splitKind === "utf8") {
        const korean = new TextEncoder().encode("안");
        const start = encoded.findIndex((value, index) =>
          value === korean[0] && encoded[index + 1] === korean[1]);
        split = start + 1;
      } else {
        split = stream.indexOf('"delta":"안녕') + '"delta":"'.length + 1;
        split = new TextEncoder().encode(stream.slice(0, split)).byteLength;
      }
      broker.enqueue({
        audience: "openai",
        route: "openai_responses",
        chunks: [
          { bytes: encoded.slice(0, split) },
          { bytes: encoded.slice(split), delayMs: 2_000 },
        ],
      });
      const controller = new AbortController();
      const observed: unknown[] = [];
      const operation = (async () => {
        for await (const chunk of adapter.streamTurn({
          ...request(MODELS.openai),
          signal: controller.signal,
        })) observed.push(chunk);
      })();
      setTimeout(() => controller.abort(), 10);
      await expect(operation).rejects.toMatchObject({ retryable: false });
      expect(JSON.stringify(observed)).not.toContain("�");
      expect(observed.some((chunk) => (chunk as { kind?: string }).kind === "tool_proposal")).toBe(false);
      expect(broker.diagnostics().transportCloseCount).toBe(1);
    },
  );
});
