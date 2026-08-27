# Tranche 3 implementation boundary

This implementation is bound to the original provider specification commit
`158d2cb7e5dbf62c125a1f347320fc494ea51b29` and the normative amendment commit
`3b51374736320b853b887bef2674922f154d4102`.

## Implemented partial scope

- A privileged broker contract accepts only a broker-issued, audience-bound
  binding lease, unique internal request/attempt identity, compiled route,
  canonical JSON bytes, and an authentic abort signal. URL, path, method,
  headers, proxy, redirect, retries, and raw credentials are not adapter
  inputs. Error identity used for fallback remains private broker state.
- The in-memory canary broker proves exact destinations, broker-owned headers,
  one attempt, redirect/proxy/retry disablement, response-header policy, raw
  byte bounds, authenticated before-body fallback proof, terminal close, and
  raw/decoded split-canary quarantine. It has no reveal or enumeration API.
- Independently authored OpenAI Responses, Anthropic Messages, and OpenRouter
  OpenResponses adapters produce canonical request bodies and strict normalized
  text, usage, tool proposal, and finish chunks from bounded SSE fixtures.
- Ordered provider/model candidates preflight as a complete list. Deep-frozen
  per-model capabilities, protocol revisions, reviewed tools, and credential
  binding revisions participate in deterministic request signatures. Opaque
  credential-handle IDs do not.
- Provider fallback is limited to privately authenticated zero-body connection
  proof or the sealed retryable HTTP status set, before visible text or a
  complete proposal. Parser, protocol, bounds, cleanup, abort, uncertainty,
  and forged public error values cannot authorize fallback.
- Provider tool definitions use one reviewed strict-schema subset and map one
  wire name to one internal `ToolId`. Provider adapters never import or invoke
  an executor. Every proposal still pauses at the existing universal gateway,
  where the router-attested reviewed manifest/schema is compared with the
  exact live gateway registration before any proposal can be prepared.
- Durable text-only history and explicit provider/model switching work end to
  end. Provider-selection evidence is schema v2 and excludes credential
  handles; legacy schema-v1 selection records remain replayable.
- Provider writes use an abort-aware journal commit guard, and dispatch remains
  bound to the exact signed provider plan across journal waits and binding
  rotation.
- Adapter response methods and iterators cross one invocation-bound sanitizer:
  only frozen broker-authentic errors for the exact request/attempt/provider/
  model/audience may pass, while every public or raw error is reconstructed.
- Provider step/cost charges are durably reconstructed across proposal pauses;
  provider token usage is never treated as trusted cost. Coordinator and tool
  authority caches are bounded; attempt-cache saturation fails closed instead
  of evicting replay-prevention state.
- Pending proposal authority binds a frozen original budget and provider plan.
  Provider charges commit only after their journal events, proposal publication
  follows its durable paused terminal, and approval consumption plus tool start
  commit as one guarded batch. Earlier durable terminals cannot be revived by
  later provider output, denial, or tool execution.
- Every durable journal draft is canonical-cloned and recursively frozen at API
  invocation before queueing. Runtime send/decision/control commands likewise
  admit exact-key immutable authority snapshots before any await. A rejected or
  uncertain guarded start irreversibly burns its grant/attempt, and durable
  denial replay preserves `human_denied` plus exact step/cost accounting.
- Explicit `undefined` on typed optional command fields is normalized to
  omission. Once a grant exists, abort/terminal/authority/deadline rejection
  burns its grant and attempt before returning, across every entry path and
  reopen recovery.

Long-lived settled replay/result caches use bounded eviction. Unresolved
request/control/retirement promises, active turns, and pending proposals use
non-evicting bounded admission and fail closed at capacity, so synchronization
authority is never discarded. The explicit tool-registration table is trusted
configuration state; this partial tranche does not claim a full-product dynamic
tool-registry design.

## Explicit deferred / HOLD scope

The following are not implemented or claimed:

- real provider continuation after tool execution;
- durable exact tool arguments, results, or provider opaque reasoning state;
- provider switching or restart recovery after a tool exchange;
- renderer or fixture state as real native authenticated human approval;
- native macOS Keychain, Windows Credential Manager/DPAPI, or Linux Secret
  Service integration;
- live provider calls, real credentials, provider SDK auto-tools, native shell,
  MCP, plugins, server tools, or provider-owned fallback; and
- full product, release, parity, or security completion.

The existing durable projection intentionally rejects tool-tainted provider
history instead of synthesizing missing payloads from hashes and receipt
summaries. A later bounded sensitive-payload vault is required.

## Reproducible evidence

- `npm run verify` passes 360/360 tests across 14 files, covering the current
  migrated baseline plus independent tranche-3 broker, stream, adapter,
  routing, authority, abort, journal, canary, history, cost-accounting, and
  universal-gateway scenarios; strict TypeScript and production build pass.
- This is not evidence that the literal sealed-parent 71 tests run unchanged.
  Intentional contract migrations include post-tool continuation becoming
  explicit HOLD, provider usage being separated from an injected trusted
  cost-accounting port, intrinsic abort-listener instrumentation replacing
  shadowable instance hooks, and the earlier single provider-selection helpers
  moving to Amendment 1's ordered exact candidates with attested capability and
  credential-authority snapshots.
- `npm audit --json`: zero vulnerabilities at every severity.
- Dependency manifests and lockfile are unchanged from the sealed specification
  baseline. All 155 non-root dependency entries resolve only from
  `registry.npmjs.org`, include integrity values, and expose a license inventory
  of Apache-2.0, BSD-3-Clause, CC-BY-4.0, ISC, or MIT.
- Builder-requested component and final holistic security re-audits report
  P0/P1/P2 = 0. The holistic acceptance review proves every amended and
  corrective item while retaining original regression item 12 as partial by
  design. The repository verification audit remains `PENDING` until the root
  verifier seals commit-bound evidence; this document does not promote it.

**Implemented tranche status: partial. Full-product status: HOLD.**
