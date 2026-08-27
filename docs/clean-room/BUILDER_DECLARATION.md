# Isolated builder declaration

Complete one copy of this declaration for every implementation tranche.

- Tranche: First vertical slice — durable conversation, provider routing, exact tool authority, runtime coordination, and desktop-facing control room
- Builder identity: Codex isolated clean-room builder
- Start and end commit: initial specification baseline `d611e1481c384429a57630cb5f0276c123e780c9`; final specification baseline `f7013a5c17d221bba3f54850a3fe84a0aace39e6`; verifier-sealed implementation commit `359fe86323ebacd9382e0da381c08680af09e7a7`
- Specifications read: `README.md`; `docs/clean-room/CHARTER.md`; `docs/clean-room/BUILDER_DECLARATION.md`; all files under `docs/spec/`, including `ARCHITECTURE.md`, `DESIGN_DIRECTION.md`, `FEATURE_MATRIX.md`, `FIRST_VERTICAL_SLICE.md`, `PRODUCT.md`, `PROVENANCE_LEDGER.md`, `SECURITY_INVARIANTS.md`, and `TEST_STRATEGY.md`
- Official standards read: None required for this process-neutral tranche; only public TypeScript, React, Vite, Vitest, and Playwright toolchains were used
- Files changed: `.gitignore`; `index.html`; `package.json`; `package-lock.json`; `tsconfig.json`; `vite.config.ts`; `public/favicon.svg`; independently authored files under `src/application/`, `src/domain/`, `src/policy/`, `src/providers/`, `src/runtime/`, `src/storage/`, `src/tools/`, and `src/ui/`; black-box tests and fixtures under `tests/`; rendered review evidence under `output/playwright/`; this declaration
- Verification: `npm run verify` passes 42 black-box/unit tests, strict TypeScript checking, and the production build; post-review gates include accepted/partial-turn crash idempotency, exact earlier-turn replay, durable terminal denial, deep append/replay schema rejection, 200 concurrent appends, and disabled production source maps

I declare that I did not inspect or use the quarantined reference archive, upstream private source, extracted symbols, prompts, assets, tests, or internal configuration while implementing this tranche. I authored the implementation from the listed clean specifications and official public standards only.

- Signature or agent task ID: `/root/isolated_builder_v1`
- Date: 2026-08-26
