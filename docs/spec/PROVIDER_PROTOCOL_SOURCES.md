# Public provider and protocol sources

Retrieved on 2026-08-26. These official sources define external contracts only. They do not authorize using consumer-session credentials, private endpoints, another application's files, copied SDK internals, or provider-specific product copy.

| Provider/protocol | Official source | Contract facts used |
|---|---|---|
| OpenAI API boundary | https://developers.openai.com/api/reference/overview | Public API origin/version, Bearer authentication, request IDs, header limits, and the rule that new optional fields and stream-event types may be added compatibly |
| OpenAI Responses | https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create | Public Responses API creates streamed/non-streamed responses; supports custom function tools; responses expose typed output items, status, usage, and streaming events |
| OpenAI streaming events | https://developers.openai.com/api/docs/api-reference/responses-streaming | Typed response/item/content state events, sequence numbers, terminal completed/incomplete/failed events, function-argument events, and error events |
| OpenAI function calling | https://developers.openai.com/api/docs/guides/function-calling | `function_call` versus `function_call_output`, `call_id` correlation, disabling parallel calls, and strict-schema requirements |
| Anthropic | https://platform.claude.com/docs/en/build-with-claude/streaming | Public Messages API uses SSE when `stream: true`; ordered message/content-block/delta/stop events; text, tool use, thinking, ping, error, and future unknown events |
| Anthropic thinking | https://platform.claude.com/docs/en/build-with-claude/extended-thinking | Thinking and redacted-thinking blocks must be preserved exactly during a tool-use turn; model generations differ in whether thinking can be disabled |
| Anthropic fallback | https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback | Server fallback is beta and opt-in through a dated beta header plus `fallbacks`; fallback blocks/model changes are observable and must not appear when omitted |
| OpenRouter OpenAPI | https://github.com/OpenRouterTeam/docs/blob/4b2651bb47fd72031b610c210fdc48aefe5ac6fd/openapi/openapi.yaml | Immutable official schema for production base URL plus `POST /responses`, OpenResponses SSE events, error classes, `store: false`, provider policy, tools, plugins, and server-tool fields |
| OpenRouter Responses guide | https://github.com/OpenRouterTeam/docs/blob/4b2651bb47fd72031b610c210fdc48aefe5ac6fd/api_reference/responses/overview.mdx | Official stateless/full-history rule, exact endpoint/authentication, and rejection of `store: true` or non-null `previous_response_id` |
| OpenRouter tool guide | https://github.com/OpenRouterTeam/docs/blob/4b2651bb47fd72031b610c210fdc48aefe5ac6fd/api_reference/responses/tool-calling.mdx | Function definitions, call/result correlation, and streamed function-argument events |
| Open Responses standard | https://www.openresponses.org/specification | Provider-neutral item/response state machines, SSE event/type matching, `[DONE]`, function-call results, and vendor-prefixed extension rules |
| OpenRouter tool model | https://openrouter.ai/docs/guides/features/tool-calling | A model proposes user-defined tool calls; the client executes separately and returns results |
| MCP current release | https://blog.modelcontextprotocol.io/posts/2026-07-28/ | MCP `2026-07-28` uses a stateless core, self-describing requests, deterministic/cacheable lists, required method/name routing headers, authorization hardening, and explicit state handles |
| MCP transports | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports | JSON-RPC UTF-8 transport safety baseline; stdio framing; Streamable HTTP origin/auth/loopback requirements and bounded request lifecycle. Used only where not superseded by `2026-07-28` |
| MCP tools draft/current | https://modelcontextprotocol.io/specification/draft/server/tools | Tool discovery, JSON Schema contracts, deterministic ordering, tool results, human-in-the-loop guidance, and the rule that server annotations are untrusted unless the server is trusted |

## Version rule

Every adapter records the external protocol revision it implements. A revision change is a new reviewed compatibility decision, not a silent parser relaxation. Unknown stream events may be ignored only where the provider's official versioning policy permits; unknown output that changes authority or tool identity fails closed.

The OpenRouter generated Responses page previously listed here returned HTTP 404 during the independent review on 2026-08-26. It is not an acceptance source. The adapter contract is instead pinned to the immutable official OpenAPI and Responses documents at commit `4b2651bb47fd72031b610c210fdc48aefe5ac6fd`; a future upgrade requires a new reviewed commit.
