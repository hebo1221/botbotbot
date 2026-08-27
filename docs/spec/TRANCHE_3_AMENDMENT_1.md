# Tranche 3 amendment 1 — sealed wire and authority contract

## Why this amendment exists

The first public-contract review found that the original OpenRouter link was no longer reproducible and that the existing normalized projection cannot reconstruct exact tool arguments and results after a tool turn. This amendment narrows the milestone before implementation and replaces ambiguous wire choices with testable rules.

It amends specification commit `158d2cb7e5dbf62c125a1f347320fc494ea51b29`. No original acceptance statement may be read more broadly than this amendment.

## Honest tranche boundary

A scoped tranche PASS may prove only:

1. durable end-to-end text-only conversation history and explicit provider/model switching;
2. credential-broker confinement and provider stream normalization;
3. provider adapter encoders against fully populated, independently authored normalized tool-call/result fixtures; and
4. end-to-end provider tool proposal → existing universal policy gateway pause, with zero external effects before the gateway receives a structurally authenticated test grant.

The following remain `DEFERRED / HOLD` because the current durable projection stores only argument hashes and receipt summaries:

- resuming a real provider after executing a tool;
- durable exact tool-result history;
- switching providers after a tool exchange;
- restart/recovery after a tool exchange; and
- any claim that the renderer or a fixture constitutes real authenticated human approval.

No adapter may synthesize missing arguments/results from hashes or summaries. A later sensitive-payload vault must preserve bounded canonical tool arguments, exact results, and any provider-required opaque reasoning state before these paths can pass.

## Selection and capability contract

- Selection is a non-empty ordered list of exact `{ providerId, modelId }` candidates, not one model shared across providers.
- The entire list preflights before broker activity. An unknown provider/model/capability, duplicate candidate, or ineligible primary is an error; the router never silently skips it.
- Each adapter exposes an immutable, deep-frozen per-model capability snapshot with a protocol revision and explicit booleans for streaming, tool proposals, image input, usage, cancellation, and opaque-reasoning round-trip.
- Each registered candidate resolves server-side to one audience-matched opaque credential handle plus a random non-secret `credentialBindingRevision`. The renderer/model cannot choose either value; the handle is never exposed, and neither value becomes model/provider data.
- Candidate selection, model IDs, capability snapshots, protocol revisions, reviewed tools, and `credentialBindingRevision` are included in deterministic request signatures. Credential-handle IDs are not. The broker must change the binding revision atomically whenever the handle, account, audience, or underlying secret changes; an idempotent replay across that change is rejected rather than dispatched under different authority.
- Provider request and attempt IDs are generated inside the privileged runtime, are bounded ASCII, and cannot be supplied by model/provider/renderer input.
- The durable `provider.selected` evidence records the exact provider, model, protocol revision, credential-binding revision, internal request ID, and fallback index, but no credential handle.
- Usage values are finite, non-negative safe integers. Usage is a distinct normalized chunk and is never treated as abstract cost without an explicit conversion policy.

Fallback is permitted only for one of these exact classes before any non-empty text delta or complete tool proposal:

- `connect_failure_before_body`: the trusted transport proves that no request-body byte was written; or
- an HTTP status in `408`, `429`, `500`, `502`, `503`, `504`, `524`, or `529` received before an SSE body is exposed.

DNS/TCP/TLS failures are retryable only when they meet the before-body proof. Connection loss, timeout, or cancellation after any body byte may have been written is `outcome_unknown` and never falls back. All other statuses—including `400`, `401`, `402`, `403`, `404`, `409`, `413`, `422`, `501`, and `505`—are non-retryable. Authentication, protocol, parser, bounds, secret-reflection, refusal, incomplete response, capability mismatch, abort, cleanup, and any failure after visible output never fall back.

## Reviewed tool-definition contract

Provider-visible tools come from an exact reviewed allowlist, never from model output. Each definition contains:

- internal stable `ToolId`;
- provider-safe wire name and bounded description;
- complete strict JSON Schema;
- canonical schema hash; and
- the existing effect manifest used by the universal gateway.

Wire names use a conservative ASCII grammar, are unique after provider normalization, and have a one-to-one immutable mapping to internal IDs. Collisions fail preflight. Object schemas require `additionalProperties: false`; every property is listed in `required` (nullable unions represent optional values); unsupported schema keywords fail preflight. Parsed proposal arguments are validated against the same schema before a proposal is emitted. Unadvertised names, built-in tools, hosted/server tools, plugins, MCP tools, and custom/free-form tools fail closed.

Provider call/item IDs are untrusted bounded correlation values and never become an internal `ProposalId`. A complete normalized tool exchange keeps provider call ID, internal tool ID, canonical arguments, exact bounded result, and outcome linked. Adapter encoders reject any incomplete or ambiguous exchange before broker activity.

## Deterministic history mapping

This tranche has no hidden system/developer prompt channel. Durable `user` and `assistant` text are mapped in original global-sequence order; an unsupported role, empty/invalid record, broken alternation, unresolved tool link, or duplicate ID fails before broker activity.

- OpenAI and OpenRouter map user text to a Responses `message` with `input_text`, assistant text to an assistant `message` with `output_text`, and a fully populated tool exchange to one `function_call` followed by its `function_call_output`. Provider item ID and `call_id` are distinct. Tool arguments and results use canonical JSON strings.
- Anthropic maps user/assistant text to Messages text blocks without reordering or silently merging authority boundaries. A fully populated exchange is an assistant `tool_use` block immediately followed by a user `tool_result` block referencing the same tool-use ID. Failed outcomes set the documented error flag; successful outcomes do not.
- Internal workspace/message/proposal/receipt IDs are not substituted for missing provider correlation IDs. Cross-provider history after a tool is deferred until the sensitive-payload vault can preserve and deliberately translate the full exchange.
- Created timestamps, receipt summaries, hashes, provider selection metadata, and credentials are not injected into model-visible text.

## Credential broker grammar

The adapter receives only an immutable exact-key `CredentialHandle` with a random opaque ID and one audience from `openai`, `anthropic`, or `openrouter`. There is no reveal, enumerate, export, stringify-secret, or raw-request escape hatch.

The adapter submits an exact-key descriptor containing only:

- the opaque handle;
- the same audience;
- an internally generated provider request ID;
- a compiled route enum;
- canonical UTF-8 JSON body bytes; and
- an abort signal.

It cannot supply a URL, origin, path text, HTTP method, headers, redirect policy, proxy, credential, or retry count. The broker maps audience plus route to constants:

| Audience | Method and destination | Broker-owned credential/header policy |
|---|---|---|
| `openai` | `POST https://api.openai.com/v1/responses` | Bearer authorization, JSON content type, SSE accept, bounded client request ID |
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | `x-api-key`, `anthropic-version: 2023-06-01`, JSON content type, SSE accept |
| `openrouter` | `POST https://openrouter.ai/api/v1/responses` | Bearer authorization, JSON content type, SSE accept; metadata/attribution headers absent |

Wrong, unknown, expired, or audience-mismatched handles are indistinguishable stable failures with zero transport calls. The trusted HTTP transport and final secret attachment live inside the broker boundary. Exactly one outbound attempt is allowed per descriptor; SDK auto-retry, environment-key discovery, ambient proxy selection, and redirects are disabled.

Tests must reject, including case/duplicate/OWS/CRLF variants, every attempted `Authorization`, `Proxy-Authorization`, `x-api-key`, `Host`, `:authority`, forwarded, connection, transfer/framing, content-length, cookie, and proxy header. Absolute/scheme-relative URLs, backslashes, dot segments, percent-encoded path changes, userinfo, fragments, queries, HTTP downgrade, every 3xx, and destination drift are impossible by type and tested at the broker boundary.

## Broker and parser bounds

Default hard limits are part of the contract and may only be lowered by a validated test configuration:

| Limit | Maximum | Counted as |
|---|---:|---|
| Canonical request body | 16 MiB | UTF-8 bytes before transport |
| Broker-generated request headers | 16 KiB | HTTP field-name/value bytes |
| Response headers | 32 KiB | raw field-name/value bytes before body exposure |
| Raw response stream | 32 MiB | bytes received before decoding |
| One SSE line | 1 MiB | raw bytes including field/value |
| One assembled SSE event | 1 MiB | raw `event` plus joined `data` bytes |
| Event count | 100,000 | comments, ping, ignored and known events all count |
| Accumulated assistant text | 8 MiB | UTF-8 bytes after delta concatenation |
| One tool argument object | 1 MiB | canonical UTF-8 JSON bytes |
| Provider/request/item/call ID | 512 bytes | ASCII or UTF-8 according to its reviewed wire grammar |
| Provider tool wire name | 64 bytes | conservative ASCII grammar |
| JSON nesting | 64 levels | arrays and objects after duplicate-key-aware parsing |
| Stream duration | 600,000 ms | monotonic elapsed time |
| Stream idle interval | 30,000 ms | time since the last received raw byte |

All numeric configuration is finite and safe-integer validated. Every boundary has N−1/N/N+1 tests. UTF-8 decoding is fatal; malformed bytes do not become replacement characters. A BOM is rejected. Parsers preserve split multibyte code points and SSE records across arbitrary transport chunks, accept LF or CRLF, accept and count SSE comments, join multiple `data:` lines with newline, and count ignored input before ignoring it. Duplicate `event` fields, `id`, `retry`, NUL, bare CR, invalid field syntax, duplicate JSON object keys, excessive JSON depth, malformed JSON, and event/type mismatch fail closed.

Only HTTP 200 plus the exact reviewed streaming content type is parsed. Media-type parameters are normalized without accepting a different media type. `Content-Encoding` must be absent or `identity`; compressed responses are rejected, so raw and decoded byte limits cannot diverge into a compression bomb. Every 3xx is a stable non-retryable redirect failure. Other statuses are classified from the numeric status alone inside the broker; their headers, status text, location, and bodies are discarded.

## Error and secret non-diffusion

The public error union contains only a stable reason code, retryability, provider audience, internally generated request ID, and coarse HTTP status class. It never exposes or chains raw `Error.message`, `cause`, `stack`, abort reason, status text, response body, response headers, provider request ID, URL, request body, or credential-bearing request headers.

Transport/network exceptions are replaced rather than wrapped. Provider error bodies and error SSE payloads are classified inside the broker/parser boundary and then discarded. A hostile provider may reflect the credential canary whole, split across stream chunks/events, encoded in JSON, or placed in IDs/errors; canary scanning across normalized output, thrown values, logs, journal, diagnostics, renderer values, and model/tool data must still find zero copies. Secret-bearing text is never accepted merely because it arrived as an ordinary assistant delta.

The test vault may expose `assertCanaryAbsent(values)` but no reveal method. The broker scans the streaming raw-byte overlap window and decoded values so a reflected canary split across chunks, SSE events, or JSON escapes cannot cross into normalized output. Test-only transport inspection of the final credential-bearing HTTP request occurs inside the broker test boundary and is never returned to an adapter.

## Common stream terminal contract

- Text deltas may stream before terminal validation and count as visible output for fallback.
- Complete tool proposals are buffered and remain non-authoritative until one successful provider terminal is validated. Incomplete, refusal, error, cancelled, or malformed streams never emit a proposal.
- This tranche sends `parallel_tool_calls: false` where supported and accepts at most one complete client function call. A second call fails closed.
- Normalized order is `delta*`, optional final usage, then either one buffered `tool_proposal` or one `finish`. A tool proposal ends the adapter iteration without an additional finish chunk.
- Exactly one success terminal is required. EOF alone never succeeds. No JSON event is accepted after a terminal.
- Unknown future/vendor-prefixed events may be ignored only if they cannot mutate a known response/item/block, call identity, model identity, usage, or authority. They still consume limits and sequence positions. Unknown core or authority-changing output fails closed.
- Abort is terminal. The broker body is cancelled, late bytes are ignored, and iterator cleanup is awaited on success, failure, fallback, and cancellation with a 1,000 ms cleanup ceiling. Cleanup failure cannot resurrect output or create an unhandled rejection.
- Race fixtures abort before dispatch, during headers, during a stalled body, across split UTF-8/JSON, between parse and consumer commit, concurrent with terminal/tool completion, and during fallback transition. Each observes one terminal outcome, zero late output/proposals/fallbacks, and one bounded transport close.

## OpenAI Responses profile

- Body contains only reviewed fields: exact model, complete input, reviewed function tools, `stream: true`, `store: false`, `parallel_tool_calls: false`, and explicit tool choice. Built-in/hosted tools and `previous_response_id` are absent.
- Function tools use the flat Responses shape with `strict: true`. `function_call.id` and `call_id` remain distinct; results correlate only by `call_id`.
- Event/type, monotonically increasing sequence, response ID, output index, item ID, content index, and item lifecycle must agree.
- Only `response.completed` succeeds. `response.failed`, `response.incomplete`, or `error` fails. An optional `[DONE]` may follow the terminal but is not a substitute for it.
- Reasoning items are never surfaced as assistant text. A tool-enabled response requiring reasoning-item round-trip is rejected unless its model capability explicitly supports opaque round-trip and the complete opaque items are present.

## Anthropic Messages profile

- Body contains exact model, complete messages, finite positive `max_tokens`, reviewed client tools, `tool_choice: {"type":"auto"}`, and `stream: true`. Thinking, `fallbacks`, beta fallback headers, server tools, MCP, and metadata are absent.
- `message_start.message.model` must equal the selected exact model. A fallback block or any model boundary fails closed.
- Blocks follow exact start → zero or more matching-index deltas → stop order. Tool JSON is parsed and schema-validated only at block stop, then buffered until `message_stop`.
- A buffered client tool proposal is authorized for emission only when the final `message_delta.stop_reason` is exactly `tool_use`. A text-only success requires exactly `end_turn`. Every other stop reason, a missing/duplicate reason, or disagreement between stop reason and block types fails without a proposal or finish.
- `ping` and permitted unknown top-level non-authority events are ignored after counting. Stream `error`, refusal, incomplete stop reason, EOF, duplicate stop, open block, thinking/redacted-thinking in a tool-enabled turn without round-trip capability, or fallback content fails.
- Usage is normalized from initial input usage plus the latest cumulative output usage and emitted once.

## OpenRouter OpenResponses profile

- Contract is pinned to official docs commit `4b2651bb47fd72031b610c210fdc48aefe5ac6fd` and the public Open Responses state machine recorded in `PROVIDER_PROTOCOL_SOURCES.md`.
- Body contains one explicit model (never `models` or a latest/router alias), complete stateless input, reviewed function tools, `stream: true`, `store: false`, `parallel_tool_calls: false`, and `provider: {"allow_fallbacks":false,"require_parameters":true}`.
- `previous_response_id`, plugins, server-tool fields, hosted/custom tools, routing aliases, debug/trace/metadata, provider order, and provider-owned model fallbacks are absent.
- OpenResponses item/sequence state is validated like the OpenAI profile. Success requires one `response.completed` followed by exactly one `[DONE]`; failed/incomplete/error terminals fail.

## Amended acceptance evidence

In addition to the original canary, bound, abort, and gateway tests, acceptance requires:

1. exact body snapshots and one transport attempt for every provider;
2. cross-audience handle, header-smuggling, destination-variant, 3xx, error-reflection, split-canary, invalid UTF-8, chunk-boundary, CRLF, multi-data-line, and limit tests;
3. per-model immutable capability, protocol revision, candidate/model fallback, ineligible-primary, usage validation, and request-signature tests;
4. advertised-tool collision/schema-hash/schema-validation and unadvertised/built-in/server/plugin rejection tests;
5. successful-terminal-before-proposal, incomplete/refusal/error/cancel-no-proposal, exactly-one-terminal, no-post-terminal, and awaited-cleanup tests;
6. durable text-only provider-switch integration;
7. component-only exact tool-call/result history encoders with fully populated records plus explicit rejection of the existing incomplete durable projection; and
8. proposal-to-gateway pause with zero effect before a structurally authenticated fixture grant, while real native human authentication and durable post-tool continuation/restart/provider-switch tests remain labeled HOLD rather than passed.

The builder declaration, feature matrix, README, and audit must call this tranche partial. The full product remains `HOLD`.
