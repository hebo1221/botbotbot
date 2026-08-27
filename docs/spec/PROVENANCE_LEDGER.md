# Provenance ledger

This ledger records where requirements came from. It does not record or reproduce third-party implementation details.

| Requirement range | Provenance | Evidence class | Implementation may use |
|---|---|---|---|
| `CR-*`, `APP-*`, `UX-*`, `PKG-*` | User objective and original project decisions | `U`, `N` | This repository's specifications and original design |
| `CONV-*`, `AGT-*`, `PRV-*`, `MCP-*`, `EXEC-*`, `ENV-*`, `DESK-*`, `ATT-*`, `MEM-*`, `TEAM-*`, `AUTO-*`, `PLUG-*` | User-visible capability inventory | `O`, with `N` improvements | Behavioral acceptance tests; official standards where applicable |
| MCP wire behavior | Model Context Protocol official specification | `S` | Official specification and conformance fixtures |
| Provider behavior | Each provider's official public API documentation | `S` | Published SDK/API contracts only |
| `POL-*`, `DATA-*`, `SEC-*`, `AUD-*`, `LINK-*` | Original safety requirements | `N` | This repository's invariants and public security standards |

Normative product behavior is recorded directly in `PRODUCT.md`,
`FEATURE_MATRIX.md`, and the tranche specifications.

## Quarantined material

Private experiments and unpublished artifacts are excluded from this repository,
build graph, tests, prompts, and implementation context.
