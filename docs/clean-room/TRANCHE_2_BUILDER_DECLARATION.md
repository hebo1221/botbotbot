# Tranche 2 isolated-builder declaration

Date: 2026-08-26
Builder role: isolated clean-room implementation agent

Specification baseline: `127edd76ff3f455488f750856e13581aa7628717`

Verifier-sealed implementation commit: `2edac16be64670f8dafafa2a28840f950041edc7`

## Scope authored

I independently implemented the second local control-kernel tranche for BotBotBot:

- persistent revisioned agent profiles;
- revisioned workspace sections and agent membership;
- atomic section deletion that projects members to unassigned without editing or deleting profiles;
- actor-complete, state-setting, idempotent reactions;
- durable epoch-bound steering and stopping integrated with provider cancellation and replay;
- strict append-time and replay-time validation for every new event;
- request-bound application ports and an original responsive control-room interface; and
- black-box acceptance tests for the twelve gates in `TRANCHE_2.md`.

## Materials consulted

Implementation decisions were based only on clean repository code and these approved files:

- `README.md`
- `docs/clean-room/CHARTER.md`
- `docs/spec/PRODUCT.md`
- `docs/spec/FEATURE_MATRIX.md`
- `docs/spec/SECURITY_INVARIANTS.md`
- `docs/spec/ARCHITECTURE.md`
- `docs/spec/TEST_STRATEGY.md`
- `docs/spec/DESIGN_DIRECTION.md`
- `docs/spec/TRANCHE_2.md`

Official local-browser tooling instructions were consulted only to operate the running clean application for responsive visual verification. They supplied no product behavior, architecture, copy, assets, or implementation detail.

I did not inspect, search, extract, diff, import, or execute any reference archive, reconstructed/private source, prior implementation, quarantined artifact, or file under a user downloads directory. No upstream binary, private credential, copied prompt, copied asset, translated symbol, or reference-derived test fixture is an implementation dependency.

## Independent design record

The following tranche details were authored for BotBotBot from the clean specifications:

- color tokens: `relay-cobalt`, `warm-coral`, `mineral-mint`, `graphite-fog`;
- abstract marks: `orbit`, `prism`, `signal`, `bridge`;
- reactions: `useful`, `clear`, `follow_up`, `celebrate`;
- one serialized workspace control service with explicit expected revisions;
- membership revision zero at creation and one increment per assignment or unassignment;
- immutable profile, section, assignment, reaction, direction, and control events;
- direction epochs beginning at one, with retirement fenced in the durable writer;
- exact send/control request signatures and a single client-request namespace;
- a calm three-pane control room with grouped agent sections, a conditional unassigned group, decision ribbons, and a 360-pixel authority bottom sheet.

## Verification evidence

From the clean working tree:

- `npm ci`: completed from the committed lockfile.
- `npm run verify`: 71 of 71 tests passed, strict TypeScript checking passed, and the production Vite build passed.
- `npm audit`: zero vulnerabilities, including zero high or critical findings.
- Journal tests cover strict primitive, enum, nested, actor, scope, revision, checksum, epoch, and replay validation while preserving corrupt bytes.
- Runtime tests cover durable-before-abort stop, hostile late chunks, duplicate and stale controls, steering history, restart interruption, active request-ID collision, stale prior-epoch controls, retired tool proposals, and targetless follow-up steering.
- Desktop visual review used an actual `window.innerWidth` by `window.innerHeight` of 1440 by 900 CSS pixels and completed with zero browser console warnings or errors.
- Mobile visual review used an actual `window.innerWidth` by `window.innerHeight` of exactly 360 by 800 CSS pixels and completed with zero horizontal overflow and zero browser console warnings or errors.
- Reviewed screenshots are stored in `output/playwright/tranche-2-desktop.jpg`, `output/playwright/tranche-2-mobile-360.jpg`, and `output/playwright/tranche-2-mobile-ledger-360.jpg`.
- `output/playwright/tranche-2-visual-audit.json` records requested and actual browser viewports, raw browser-export dimensions, exact evidence-canvas dimensions, document overflow metrics, console counts, captured states, and SHA-256 hashes. Raw exports are retained beside the exact-size evidence canvases; the audit explains the in-app browser's reserved-pixel exclusion without concealing it.
- `git diff --check`: passed.
- No file under `docs/spec/` was modified.

## Claim boundary

This declaration covers only the second local implementation tranche. Cross-device synchronization and all later feature-matrix work remain outside this tranche. It is not a parity, release, security-completion, or full-product declaration.

**Full-product status: HOLD.**
