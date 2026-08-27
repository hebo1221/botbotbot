# Tranche 3 — public provider broker and credential non-diffusion

> Amendment 1 is normative. Where this file conflicts with `TRANCHE_3_AMENDMENT_1.md`, the amendment controls.

## Outcome

BotBotBot can route the existing durable conversation through independently authored adapters for the public OpenAI Responses, Anthropic Messages, and OpenRouter OpenResponses APIs without reading another application's login, exposing raw credentials to the renderer/model, or executing model-proposed tools outside the universal gateway.

This tranche advances `PRV-001`, `PRV-002`, `SEC-001`, `SEC-002`, and `AUD-001`. Actual OS-keychain and native-shell integration remains a later tranche; this tranche proves the broker contract and non-diffusion behavior with a canary vault.

## Forbidden integration paths

- consumer ChatGPT, Claude, Codex, or other application session files;
- undocumented/private web endpoints;
- environment variables, command-line arguments, logs, errors, renderer messages, journal events, or tool/model payloads containing raw secrets;
- provider SDK features that execute tools automatically; and
- silent provider/model substitution after visible output.

## Credential boundary

Application state stores only an opaque `CredentialHandle` containing a random identifier and provider audience. The handle is not a token and reveals no secret metadata.

A privileged credential broker owns the secret and exposes one operation:

```text
authorized request descriptor
  → exact provider audience/destination validation
  → secret attached inside broker
  → bounded HTTP exchange
  → normalized redacted response/stream
```

The provider adapter supplies method, an allowlisted relative API path, public headers, and body. It cannot set authorization headers, redirect to another origin, request an arbitrary URL, or retrieve the secret. Redirects are disabled. Broker errors contain stable classes and request IDs, never provider bodies or credentials.

The production broker later maps handles to macOS Keychain, Windows Credential Manager/DPAPI, or Linux Secret Service. The tranche test broker uses an in-memory canary and exposes only a scan assertion, not a reveal method.

## Common provider contract

Each adapter:

- receives a complete normalized conversation and explicit model ID;
- declares streaming, tool-proposal, image-input, usage, and cancellation capabilities explicitly;
- uses a stable BotBotBot provider request ID and abort signal;
- emits normalized text deltas, complete tool proposals, usage, and finish only;
- never calls a tool executor;
- bounds event bytes, accumulated response bytes, tool argument bytes, event count, and time;
- rejects duplicate output item/call identities and malformed ordering;
- treats cancellation as terminal and ignores late bytes; and
- maps provider errors into redacted retryable/non-retryable classes.

The existing router remains authoritative for fallback: retry is permitted only before visible text/tool output and only for a classified retryable transport failure.

## OpenAI Responses adapter

- Uses the documented public Responses API with `stream: true` and `store: false`.
- Converts normalized history to documented input message/tool-result items.
- Converts reviewed BotBotBot tool manifests into strict custom function definitions.
- Accumulates output text events in order.
- Emits a tool proposal only after a complete function-call item has a stable call ID, reviewed tool name, and valid JSON object arguments.
- Captures final usage from the completed response.
- Built-in/hosted tools are disabled in this tranche.

## Anthropic Messages adapter

- Uses the documented public Messages API with `stream: true`.
- Handles the official message start → content block start/delta/stop → message delta → message stop flow.
- Ignores `ping`; surfaces stream `error`; gracefully skips unknown non-authority events.
- Accumulates text by content-block index.
- Accumulates tool-use JSON only within its block and emits a proposal after block completion and valid object parsing.
- Thinking/reasoning content is not exposed as assistant text or persisted as hidden chain-of-thought.
- Tool results are sent back using the documented tool-result content block.

## OpenRouter OpenResponses adapter

- Uses the documented public `/api/v1/responses` contract with `stream: true` and `store: false`.
- Uses explicit model identifiers supplied by user configuration; no implicit “latest” alias in verified defaults.
- User-defined functions remain manual and go through the universal gateway.
- OpenRouter server tools and plugins are disabled in this tranche because they execute outside BotBotBot's policy/receipt boundary.
- Provider fallback configured inside OpenRouter is disabled; BotBotBot owns visible fallback policy.

## Network and privacy policy

- Exact HTTPS origins and paths are compiled per adapter.
- No HTTP downgrade, redirects, proxy-from-input, custom host header, or userinfo URL.
- Request metadata is allowlisted: provider ID, model ID, request ID, timing, status class, and token counts.
- Prompt text, tool arguments/results, response text, headers, and bodies are absent from telemetry by default.
- A secret canary is scanned across thrown errors, logs, journal, normalized chunks, request bodies visible outside the broker, and exported diagnostics.

## Acceptance tests

1. Each adapter sends only to its exact official origin/path through the broker and cannot override authorization.
2. Adapters receive only credential handles; the canary is absent from adapter state, logs, errors, events, journal, renderer-facing values, and model/tool payloads.
3. OpenAI fixture streams ordered text, a complete function call, usage, and finish; malformed/duplicate/out-of-order calls fail closed.
4. Anthropic fixture covers ordered text blocks, fragmented tool JSON, ping, error, unknown future event, usage, and message stop.
5. OpenRouter fixture covers OpenResponses text/tool/usage while proving server tools/plugins and provider-owned fallback are absent.
6. Tool proposals from all three adapters pause at the existing universal policy gateway; external effect count is zero before an exact human grant.
7. Abort during a stalled stream returns promptly and commits no late delta.
8. A retryable pre-output 429/5xx/transport failure may use the router fallback; any visible output prevents fallback.
9. Event, byte, argument, duration, and response bounds fail with stable redacted errors.
10. Complete conversation history, including provider changes and tool receipts, maps deterministically for each provider.
11. Unknown model capability fails preflight before broker/network activity.
12. All existing 71 tests remain green; clean checkout, typecheck, build, audit, and diff checks pass.

## Done gate

- No real provider credentials or network calls are required for verification.
- Fixtures are independently authored from the public contracts in `PROVIDER_PROTOCOL_SOURCES.md`.
- A fresh isolated builder signs a tranche declaration.
- Full-product status remains HOLD; actual native keychain/UI setup and MCP are not claimed complete.
