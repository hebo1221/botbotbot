# Tranche 2 completion audit

Tranche 2 status: `PASS` at implementation commit `2edac16be64670f8dafafa2a28840f950041edc7`.

Full-product status: `HOLD`. Native shell wiring, real providers/MCP, cross-device sync, isolated compute, remote display, automations, memory, and remaining feature-matrix rows are not complete.

| Gate | Required evidence | Result |
|---|---|---|
| Isolated builder | Task `/root/isolated_builder_v2`, forked with no prior turns; signed declaration and exact specification/implementation commits | PASS |
| Regression | All 42 tranche-1 tests remain within the 71-test green suite | PASS |
| Agent persistence | Create/update, status transitions, revision conflict, request replay, and restart projection tests pass | PASS |
| Section semantics | Revisioned create/rename/reorder/assign/unassign/delete; atomic delete tests preserve profiles and project members unassigned | PASS |
| Scope isolation | Foreign and unknown membership targets return the same scope-safe error with zero writes | PASS |
| Reaction concurrency | 200 independent identities survive exactly once across restart; same-identity sequence resolution preserves unrelated reactions | PASS |
| Stop authority | Journal fsync is observed before provider abort; terminal is once; duplicate/stale controls do not abort; hostile late chunks are absent | PASS |
| Steering | Epoch 1 retires, epoch 2 receives one direction and complete committed history; stale epoch controls cannot affect newer work | PASS |
| Crash recovery | Persisted incomplete send/control requests return explicit interruption/reconciliation without provider redispatch or duplicate event | PASS |
| Runtime schemas | Exact fields, bounds, actor rules, primitive/enum/nested shapes, semantic revisions, scopes, message existence, and epoch fences pass append/replay tests | PASS |
| UI authority | Workspace/reaction/turn mutations require exact receipt plus refreshed view at or beyond the durable sequence; mismatches preserve old UI state | PASS |
| Visual/accessibility | 1440×900 and 360×800 viewport states audited; raw exports retained; horizontal overflow 0; console warnings/errors 0; 44px targets, focus, reduced motion, modal ledger, and non-focusable ribbon nodes verified | PASS |
| Supply chain | Existing lockfile unchanged; registry-only dependencies; npm audit total 0 | PASS |
| Full-scope honesty | Declaration, README, feature matrix, and audit keep the full product on HOLD | PASS |

## Audit rule

Green tests count only after their assertions and entry paths are inspected. A UI control is not proof of a durable feature. A durable event is not proof of a provider abort unless the test observes the provider signal and rejects late output.

## Evidence

Commands run on 2026-08-26:

```sh
npm run verify
npm audit --json
git diff --check
```

Results:

- 71/71 tests passed across eight suites;
- strict TypeScript checking passed;
- production Vite build passed with source maps disabled;
- npm audit reported zero vulnerabilities; and
- `docs/spec/` remained unchanged during isolated implementation.

Visual evidence is bound by `output/playwright/tranche-2-visual-audit.json`, which records raw and final dimensions, requested/actual browser viewport, document widths, overflow, console counts, captured states, transformations, and SHA-256 hashes. The raw screenshots are retained beside exact-size evidence canvases.

## Clean-checkout reproduction

Sealed evidence commit `d7fca3aef63b725ae62877fa4fc672c50dcac51b` was checked out into a separate detached worktree with no installed dependencies.

- `npm ci --no-audit --no-fund` installed 105 packages from the committed lockfile;
- all 71 tests passed;
- strict typecheck passed;
- the production build passed with source maps disabled;
- npm audit reported zero vulnerabilities; and
- the detached worktree remained clean.

The temporary worktree and generated dependencies were removed after verification. The primary worktree also has no generated `node_modules/` or `dist/`; run `npm ci` to restore the development environment.
