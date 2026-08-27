# Tranche 3 completion audit

Amended partial-boundary status: `SCOPED PASS` at effective implementation commit
`4ecc867201cb1df84a7b3d52f2f7173e77ec9bb2`.

Original unchanged-regression item 12: `INTENTIONAL PARTIAL`. The current
migrated suite passes, but the literal sealed-parent 71 tests are not claimed
to run unchanged after the approved provider/history/cost/abort contract
migration.

Full-product status: `HOLD`. A passing provider-adapter tranche will not complete native credential storage, durable sensitive tool payloads, post-tool continuation/recovery/provider switching, MCP, isolated compute, remote display, attachments, automations, memory, sync, team administration, packaging, or the remaining feature matrix.

| Gate | Required evidence | Result |
|---|---|---|
| Isolated builder | Fresh builder with no reference or prior-conversation access; signed declaration binds exact specification and implementation commits | PASS |
| Regression | Current migrated baseline remains green; literal unchanged historical 71-test compatibility is not claimed | INTENTIONAL PARTIAL |
| Public contracts | OpenAI Responses, Anthropic Messages, and OpenRouter OpenResponses adapters match the reviewed official public contracts | PASS — fixtures, no live-provider claim |
| Credential boundary | Adapters receive broker-owned opaque leases only; broker alone attaches a canary secret after exact audience, origin, path, method, header, and attempt checks | PASS — test broker, native storage HOLD |
| Secret non-diffusion | Canary is absent from adapter state, request descriptors outside the broker, errors, logs, events, journal, diagnostics, renderer, and model/tool data | PASS |
| Network confinement | HTTPS origins and paths are compiled per provider; redirects, arbitrary URLs, custom auth/host headers, userinfo, input proxies, retries, and compression fail closed | PASS — contract/fixture, production transport HOLD |
| Stream parsers | Ordered text, fragmented function calls, terminal inventories, usage, finish, unknown-event policy, duplicates, malformed order, size, idle, duration, and cleanup limits are fixture-tested | PASS |
| Tool authority | Provider proposals pause with zero effects until the gateway accepts a structurally authenticated fixture grant; grant/start and denial transitions are guarded and monotonic | PASS — native human authentication HOLD |
| Tool-history honesty | Durable text history passes end to end; exact tool-history encoders pass only with complete fixtures; missing durable arguments/results fail preflight | PASS — post-tool continuation remains HOLD |
| Abort and fallback | Abort produces no late output/authority; fallback requires a one-use exact-attempt broker attestation before visible output | PASS |
| Capability preflight | Adapter-pinned revisions and actual per-model capabilities reject unsupported models/features before broker activity | PASS |
| Deterministic history | Durable text-only provider changes map end to end; fully populated component tool exchanges map exactly; incomplete durable tool history is rejected | PASS — amended boundary |
| Runtime/journal authority | Commands and journal drafts snapshot before waits/queueing; terminal precedence, cost/step replay, capacity, grant burn, and idempotent denial survive races/restart | PASS |
| Supply chain | Manifests/lockfile unchanged; registry, integrity, licenses, audit, and generated artifacts reviewed | PASS |
| Full-scope honesty | README, feature matrix, declaration, implementation boundary, and this audit retain the partial/full-product HOLD boundary | PASS |

## Audit rule

Passing fixtures alone do not prove credential safety. The verifier must inspect every value crossing the broker boundary and scan serialized errors, logs, durable events, diagnostics, and renderer-facing values with a unique canary. No real provider credential or live network call is permitted for this gate.

## Root-verifier evidence

Commands reproduced on 2026-08-26 in both the primary worktree and a new
detached worktree at commit `4ecc867201cb1df84a7b3d52f2f7173e77ec9bb2`:

```sh
npm ci --no-audit --no-fund
npm run verify
npm audit --json
git diff --check
```

Results:

- 360/360 tests passed across 14 files;
- strict TypeScript and production Vite build passed;
- npm audit reported zero vulnerabilities at every severity;
- `npm ci` installed 105 platform-relevant packages from the unchanged lock;
- the lock contains 155 non-root dependencies, all from `registry.npmjs.org`
  with integrity values; installed licenses are Apache-2.0, BSD-3-Clause,
  CC-BY-4.0, ISC, or MIT with none missing;
- `docs/spec/`, `package.json`, and `package-lock.json` are unchanged from the
  sealed amendment commit;
- static scans found no ambient credential/session read, live-network client,
  real-secret pattern, reference-archive path, or provider executor import;
- the detached worktree remained clean; and
- independent root runtime and evidence re-audits returned P0/P1/P2 = 0.

The builder declaration's self-reference-safe payload tree
`b3dbf36f18e69954a3970511a451d8c3905ba0d1` was independently reconstructed
from the effective implementation commit and matches exactly.

## Deferred authority

This PASS does not promote native keychain storage, a live HTTP transport,
native authenticated-human confirmation, exact durable sensitive tool
payloads, provider continuation/recovery/switching after a tool exchange, or
any full-product feature. Those remain explicit HOLD gates.
