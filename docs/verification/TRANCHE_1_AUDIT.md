# Tranche 1 completion audit

Tranche 1 status: `PASS` at implementation commit `359fe86323ebacd9382e0da381c08680af09e7a7`.

Full-product status: `HOLD`. The feature matrix remains intentionally incomplete; this audit proves only the first vertical slice.

| Gate | Required evidence | Result |
|---|---|---|
| Clean builder isolation | Builder task `/root/isolated_builder_v1`; signed tranche declaration; isolated `fork_turns=none` implementation context | PASS |
| Repository independence | Quarantined archive absent from repository/build; forbidden implementation token and path scans returned zero matches | PASS |
| Dependency provenance | npm lockfile v3; 155 resolved artifacts from `registry.npmjs.org`; no git/file/http dependencies; `npm audit` total 0 | PASS |
| Type safety | `npm run typecheck` succeeds with strict TypeScript settings | PASS |
| Unit/acceptance tests | `npm test`: 42/42 pass across journal, policy/gateway, router, coordinator, and UI | PASS |
| Durable concurrency | 200 concurrent cross-conversation appends retained exactly once in global order and replay identically after reopen | PASS |
| Corruption behavior | Truncation, checksum mutation, malformed primitive/enum/nested records, duplicate IDs, partial-write poisoning, live lock, and dead-PID recovery tests pass | PASS |
| Policy closure | Direct/routed/retry/resume paths share one gateway; unknown/self-approved/mismatched/expired/replayed/denied grants and restart re-execution are blocked | PASS |
| Provider continuity | Explicit routing, capability preflight, pre-output fallback, post-output stop, and two-provider one-history tests pass | PASS |
| Runtime causality | Durable proposal → policy → human grant → consumption → execution → receipt ordering, interruption, cancellation, exact idempotency replay, and budget tests pass | PASS |
| UI build | `npm run verify` production build succeeds; 205.34 kB JS, 12.55 kB CSS, production source maps disabled | PASS |
| Visual QA | Desktop and 360px screenshots inspected; second browser run has zero console errors; focus, mobile, reduced-motion, disabled control-port states tested | PASS |
| Full-scope honesty | README, matrix, declaration, and this audit label the work as a partial tranche; no full-product/release-ready claim | PASS |

## Evidence rules

- A test counts only after its assertions are inspected and shown to cover the requirement.
- A manifest or declaration counts only after its referenced files and hashes are verified.
- “No match found” is not proof of legal independence; it supplements role separation and provenance records.
- Results produced from a dirty or dependency-mutated tree must be repeated from a clean checkout before release promotion.

## Evidence commands

Run on 2026-08-26 from the repository root:

```sh
npm run verify
npm audit --json
git diff --check
git status --short
```

Visual evidence:

- `output/playwright/control-room-desktop.png` — SHA-256 `98849613e34e0c1c178bfc206c175f5f3ec8741684079d78d5b4ae7c327f3fca`
- `output/playwright/control-room-mobile.png` — SHA-256 `dbe09a0802ba9803e4b11846f2e6c7d3311d828d7bdd78e786466faa2e719b18`

Remaining release work is governed by `docs/spec/FEATURE_MATRIX.md`; every non-verified row keeps the full product on HOLD.

## Clean-checkout reproduction

Commit `0724ea2afa6a2233591fa029b32de296ad5b6d79` was checked out into a separate detached worktree and verified from no installed dependencies:

- `npm ci --no-audit --no-fund` installed 105 packages from the lockfile;
- 42/42 tests passed;
- strict typecheck passed;
- production build passed with no source maps;
- npm audit reported zero vulnerabilities; and
- the detached worktree remained clean.

The temporary worktree and its generated dependencies were removed after verification. This primary worktree's generated `node_modules/` and `dist/` were also removed to preserve disk space; `npm ci` recreates them.
