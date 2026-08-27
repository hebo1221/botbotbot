# Test strategy

Tests are black-box evidence for behavior and safety. They must not encode third-party internal structures, strings, fixtures, or implementation details.

## Deterministic harness

The project provides:

- scripted fake providers with request journals, streaming, capability declarations, cancellation, and failure points;
- read-only, mutating, destructive, slow, failing, idempotent, and non-idempotent tool probes;
- an immutable external side-effect ledger;
- controllable approval client and clock;
- process/crash and storage-fault injection;
- concurrency barriers and idempotency keys; and
- secret canaries scanned from logs, errors, exports, storage, and UI events.

Provider selection is proved by provider request journals. Tool execution is proved by the external effect ledger, not an internal mock call count.

## First-slice cases

| ID | Scenario | Required observable result |
|---|---|---|
| C01 | Korean, emoji, multiline, and normalization-sensitive text | Exact round trip before and after restart |
| C02 | Multi-chunk streaming response | Ordered deltas and one committed assistant message |
| C03 | Cancel during streaming | Upstream cancellation and no later committed output |
| C04 | Duplicate client request ID | One user turn and the original result |
| C05 | Concurrent conversations | No content, event, provider, or cursor leakage |
| R01 | Explicit provider selection | Exactly the selected adapter receives the request |
| R02 | Required capability unavailable | Preflight failure and zero provider/tool requests |
| R03 | Failure after visible output | No silent fallback or duplicate completion |
| R04 | Provider switch within one conversation | Both providers receive one complete normalized history |
| T01 | Unknown or unclassified tool | Denied before any effect |
| T02 | Mutation through every entry path | Zero effects before exact approval |
| T03 | Changed arguments, actor, conversation, expiry, policy, or replay | Grant rejected and zero new effects |
| T04 | Policy change while pending | Re-evaluate and fail closed when no longer permitted |
| T05 | Non-idempotent ambiguous failure | `outcome-unknown`; no blind retry |
| D01 | 200 concurrent cross-conversation appends | Every acknowledged event retained once in global order |
| D02 | Message, reaction, title, and status written concurrently | Independent updates preserved |
| D03 | Kill or failure at persistence phases | Wholly old or wholly new state, never partial success |
| D04 | Checksum/truncation corruption | Visible recovery-required state; original bytes preserved |
| D05 | Second process opens the store | Coordinated writer or explicit lock failure, never split-brain |

## Promotion gates

### Pull request

- deterministic cases pass;
- 200 generated state-machine traces pass;
- secret canary leakage is zero; and
- every tool proposal has a complete causal audit chain.

### Nightly

- 10,000 concurrent mutations with zero lost/duplicate acknowledged operations;
- 10,000 randomized policy traces with zero unauthorized effects;
- 1,000 provider failure/fallback traces; and
- supported-provider conformance matrix.

### Release

- 100,000 policy/property sequences with zero bypasses;
- 1,000 kill-point recovery trials with zero corruption or false acknowledgement;
- 24-hour concurrency/reconnect soak;
- restore drill and migration from every released schema;
- renderer-compromise, sandbox, remote-content, and supply-chain security gates;
- signed SBOM, artifact checksums, dependency license report, and provenance declaration; and
- every feature row linked to executable evidence.

Thresholds may be strengthened. Weakening one requires an explicit recorded release decision.
