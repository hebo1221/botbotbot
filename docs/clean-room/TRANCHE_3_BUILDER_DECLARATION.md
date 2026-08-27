# Tranche 3 isolated-builder declaration

Date: 2026-08-26
Builder role: isolated clean-room implementation agent
Builder task ID: `/root/isolated_builder_v3`

## Specification and implementation identity

- Original approved specification commit:
  `158d2cb7e5dbf62c125a1f347320fc494ea51b29`
- Sealed normative amendment commit:
  `3b51374736320b853b887bef2674922f154d4102`
- Implementation commit: the fourth separate corrective feature commit
  containing this updated declaration; its exact post-commit hash is reported
  in the implementation handoff.
- Precise pre-commit implementation payload tree, excluding only this
  self-referential declaration:
  `b3dbf36f18e69954a3970511a451d8c3905ba0d1`

The payload tree is used because embedding the containing Git commit hash in
that same commit would change the hash recursively.

## Clean materials consulted

I read the clean-room charter, README, every approved file under `docs/spec/`,
the tranche-3 verification audit, the existing independent source/tests, and
the prior tranche builder declarations in this repository.

Provider implementation decisions used only the official public sources
enumerated in `docs/spec/PROVIDER_PROTOCOL_SOURCES.md`, including:

- OpenAI public API overview, Responses reference/streaming events, and
  function-calling guide;
- Anthropic public Messages streaming, thinking, and fallback documentation;
- OpenRouter's official documentation repository pinned at commit
  `4b2651bb47fd72031b610c210fdc48aefe5ac6fd`;
- the public Open Responses specification; and
- the clean amendment's reviewed wire decisions.

I did not inspect, search, extract, diff, import, execute, or derive from any
reconstructed/reference archive, a user downloads directory, another
product's bundle/source/tests/assets/configuration, prior rollout or memory,
consumer login/session files, private endpoint, undocumented API, leaked
credential, or upstream binary. I did not use live provider credentials or
make live provider requests.

## Independently authored scope

- Exact route-only privileged credential-broker contract and terminal canary
  vault with no reveal/enumeration/export API.
- Canonical-byte request validation, broker-owned destinations/headers,
  privately authenticated fallback proof, strict response-header policy, raw
  and decoded canary quarantine, and bounded terminal cleanup.
- Duplicate-key-aware strict JSON and byte-oriented SSE framing with all sealed
  request, response, line, event, text, argument, ID, nesting, count, idle,
  duration, and cleanup limits.
- Independent OpenAI Responses, Anthropic Messages, and OpenRouter
  OpenResponses encoders and streaming state machines.
- Deep-frozen per-model capabilities, ordered exact provider/model candidates,
  reviewed tool schemas, deterministic authority signatures, broker-owned
  binding-lease rotation protection, sealed per-attempt fallback, exact
  gateway-registration binding, and distinct usage/cost accounting.
- Abort-aware guarded journal commits and schema-v2 durable provider-selection
  evidence with legacy schema-v1 replay.
- Invocation-bound adapter error reconstruction, monotonic turn-terminal
  authority, guarded atomic approval-consumption/tool-start commits, immutable
  original turn budgets, and commit-exact live/replay accounting.
- Synchronous pre-enqueue journal draft snapshots, exact immutable runtime
  command admission, irreversible one-use grant/attempt reservation on failed
  starts, and denial replay with exact durable reason/accounting.
- Typed optional command fields normalize explicit `undefined` to omission;
  abort or authority loss after grant persistence still burns the grant and
  attempt before any early exit.
- Durable text-only provider switching, complete component-only tool-history
  encoders, rejection of incomplete durable tool history, and proposal pause at
  the existing universal gateway.

Provider adapters do not import an executor. Built-in, hosted, server, plugin,
MCP, custom/free-form tools, provider-owned fallback, and automatic tool
execution remain disabled.

## Dependency and supply-chain declaration

- `package.json` and `package-lock.json`: unchanged.
- New runtime or development dependencies: none.
- `npm audit --json`: zero info, low, moderate, high, or critical findings.
- Lockfile version 3 contains 155 non-root dependency entries, all resolved only from
  `registry.npmjs.org`, with zero missing integrity values.
- Installed dependency license inventory: Apache-2.0, BSD-3-Clause,
  CC-BY-4.0, ISC, and MIT; zero missing license fields.
- No generated `node_modules/` or `dist/` artifact is tracked.

## Verification evidence

- `npm ci --no-audit --no-fund`: completed from the committed unchanged lockfile.
- `npm run verify`: 360/360 current migrated-baseline and independent
  tranche-3 tests passed across 14 files; strict TypeScript and the production
  Vite build passed. This does not claim the literal sealed-parent 71 tests run
  unchanged; the intentional four-part contract migration is recorded in
  `TRANCHE_3_IMPLEMENTATION.md`.
- `npm audit --json`: zero vulnerabilities.
- `git diff --check`: passed.
- Secret-key-pattern, ambient credential/session, live-network, and provider
  executor-import scans: passed; only the pre-existing durable-journal process
  test at `tests/durableJournal.test.ts` imports `node:child_process`.
- Builder-requested journal, runtime-command, and final holistic security
  re-audits: P0/P1/P2 = 0.
- Builder-requested final holistic acceptance review: every amended and
  corrective item proven with no new partial; original regression item 12
  remains partial by design because unchanged historical-test compatibility
  and the root clean seal are not claimed.
- The root-controlled `docs/verification/TRANCHE_3_AUDIT.md` remains `PENDING`;
  these builder-side reviews do not claim root-verifier PASS.
- No file under `docs/spec/` and no dependency manifest/lockfile was modified by
  the implementation commit.

## Claim boundary

This declaration covers the partial amended tranche only. Real native human
authentication, native OS credential storage, a durable sensitive-payload
vault, real provider continuation after a tool, durable exact tool-result
history, post-tool provider switching/restart recovery, MCP, native shell,
plugins, and all other incomplete feature-matrix rows remain deferred.

**Implemented tranche status: partial. Full-product status: HOLD.**
