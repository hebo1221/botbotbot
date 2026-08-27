# BotBotBot

[![CI](https://github.com/hebo1221/botbotbot/actions/workflows/ci.yml/badge.svg)](https://github.com/hebo1221/botbotbot/actions/workflows/ci.yml)

BotBotBot is an open-source local AI workspace prototype for coordinating
conversations, providers, approvals, and agent activity without exposing API
keys to the browser renderer.

This repository contains BotBotBot's independently authored control-plane,
provider, policy, storage, and workspace foundations. Product-specific private
experiments and unpublished assets are maintained outside this public source
edition.

## What works

- React/Vite workspace UI with agents, conversations, sections, approvals,
  reactions, provider selection, budgets, and responsive layouts.
- Deterministic OpenAI, Anthropic, and OpenRouter protocol adapters with bounded
  streaming parsers and explicit capability negotiation.
- Credential-broker contracts that keep raw provider secrets outside renderer
  and adapter boundaries.
- Durable conversation, provider selection, approval, execution, and audit
  state with crash/replay tests.
- Exact tool-policy and one-use approval foundations with no implicit effect.

This is a development alpha, not a finished security or parity claim. The
current verification boundary is covered by the test suite; native credential
storage, authenticated human approval, desktop packaging, and binary
distribution remain future work.

## Run locally

Requirements: Node.js 22.19 or newer.

```sh
npm ci
npm run verify
npm run dev
```

The public UI is a deterministic local control-room prototype and makes no live
provider request.

## Verification

```sh
npm run verify
```

This runs the complete Vitest suite, strict TypeScript checking, and the
production renderer build. It does not make a live provider request.

## Repository guide

- `src/ui/` — independent renderer and control ports
- `src/providers/` — provider normalization and routing contracts
- `src/runtime/` — runtime coordination and replay logic
- `src/tools/` — policy-gated tool gateway foundations
- `docs/spec/` — architecture, security invariants, and coverage matrix
- `tests/` — deterministic and adversarial verification

## Public-release boundary

This repository publishes source code only. It does not redistribute
`node_modules` or a packaged desktop binary. A binary release requires a
separate SBOM, license-asset pruning, signing, notarization, and security
review.

## License

BotBotBot source code is available under the [MIT License](LICENSE).
