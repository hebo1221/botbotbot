# Feature coverage matrix

Status values are `specified`, `building`, `verified`, or `blocked`. Only `verified` counts toward completion.

| ID | Provenance | Capability | Core acceptance gate | Status |
|---|---|---|---|---|
| CR-001 | U,N | Independent repository and provenance ledger | Reference-derived code/assets/configuration count is zero | specified |
| APP-001 | U,O | Installable desktop application | Clean checkout builds, installs, launches, exits, and relaunches without upstream binaries | specified |
| AUTH-001 | O,N | Dedicated account sign-in and lifecycle | Browser-based OAuth/PKCE sign-in, return, refresh, sign-out, revoke, and recovery are independently testable | specified |
| AUTH-002 | O,N | Browser-session credential opacity | A user can sign in to a site inside an isolated work environment without the agent, model, logs, or renderer receiving the password | specified |
| ONB-001 | O,N | First-run agent setup and suggestions | Create an agent with independent profile attributes and receive dismissible, context-aware starting suggestions | building |
| CONV-001 | O | Conversation lifecycle and durable streaming | Create, send, stream, cancel, restart, and resume one coherent timeline | building |
| CONV-002 | O,N | Reactions and concurrent edits | 100 repeated concurrent mutation trials produce zero loss or cross-talk | building |
| CONV-003 | O,N | Steering and stopping active work | A follow-up can narrow, redirect, or stop a running turn with a durable terminal outcome | building |
| AGT-001 | O,N | Agent loop with tool result continuation | Model output, tool proposal, decision, result, and follow-up are causally linked and cancellable | building |
| AGT-002 | N | Time, step, and cost budgets | Runtime halts before exceeding configured limits and records the reason | specified |
| AGT-003 | O,N | Persistent named agents | Agent profile, memory scope, background state, and active work survive client disconnect and restart | building |
| PRV-001 | O,S | Independent provider adapters | Each provider configures, validates, streams, and fails independently | building |
| PRV-002 | N,S | Explicit provider capability negotiation | Unsupported streaming/tool/model features are rejected before a turn begins | building |
| MCP-001 | O,S | MCP connection, discovery, schemas, and calls | Official protocol contract tests pass against a test server | specified |
| MCP-002 | O,S | MCP setup and removal | Invalid config cannot persist; each mutation has a visible result and audit event | specified |
| POL-001 | O,N | Universal policy gate | UI, agent, provider, MCP, automation, and retry paths share one policy decision point | building |
| POL-002 | N | Exact-action approval | Mutations cannot run without a fresh one-use approval bound to tool, arguments, actor, and conversation | building |
| EXEC-001 | O,N | Local command execution | Default is ask; denial creates no process; target and working directory are visible | specified |
| ENV-001 | O,N | Isolated local work environment | Immutable image identity, least privilege, scoped mounts, lifecycle recovery, and explicit deletion | specified |
| ENV-002 | O,N | Remote work environment | Authentication, disconnect, reconnect, duplicate prevention, and shutdown have distinct states | specified |
| ENV-003 | O,N | Conversation/workspace failure separation | Workspace deletion or reset cannot delete conversation history; synced and local-only data have explicit recovery boundaries | specified |
| DESK-001 | O,N | Remote desktop display and input | Only a pre-authorized exact origin can load; arbitrary web origins are rejected before attachment | specified |
| DESK-002 | O,N | Clipboard exchange | Directional, explicit consent; no background read/write; secrets receive an extra warning | specified |
| ATT-001 | O,N | Attachments and media | Bounded ingest, preview, download, deduplication, and ownership checks | specified |
| LINK-001 | O,N | Safe link preview | HTTPS only, DNS pinning, private-address blocking, redirect revalidation, byte/time limits | specified |
| MEM-001 | O,N | User-controlled memory | Scope, provenance, retention, correction, export, and deletion are inspectable | specified |
| TEAM-001 | O,N | Multiple agents and shared spaces | Membership, isolation, sharing, and concurrent updates preserve access boundaries | specified |
| ORG-001 | O,N | User-defined sidebar sections | Create, rename, reorder, move, and delete a section without deleting its agents; ungrouped agents remain available | building |
| SYNC-001 | O,N | Cross-device state synchronization | Agents, conversations, sections, routine state, and usage reconcile across desktop and a mobile client without silent last-writer loss | specified |
| AUTO-001 | O,N | Scheduled and event-driven routines | Explicit schedule, authority, expiry, idempotency, run history, pause, and deletion | specified |
| PLUG-001 | O,S,N | Integration/plugin lifecycle | Signed or integrity-pinned source, permission diff, install/update/remove, and isolation | specified |
| PLUG-002 | O,N | Marketplace discovery and organization policy | Browse/search, connect from context, resume OAuth, show installed state, and enforce admin availability without client bypass | specified |
| DATA-001 | O,N | Atomic durable storage | Concurrent writes, crash recovery, corruption, and replay tests never silently reset data | building |
| DATA-002 | N | Backup, restore, and export | Round-trip restore succeeds; secrets are excluded unless separately encrypted | specified |
| SEC-001 | O,N | Secure credential storage | OS keychain; no plaintext in UI, logs, diagnostics, storage, or default exports | specified |
| SEC-002 | N | Scoped runtime credential delegation | No whole auth-directory mounts; delegated tokens expire and can be revoked | specified |
| AUD-001 | N | Human-readable audit trail | Approval, execution, connection, credential delegation, and policy outcome are attributable | building |
| UX-001 | U,N | Original accessible interface | Independent copy/layout/assets; keyboard, screen reader, mobile-width, and reduced-motion checks | building |
| PKG-001 | U,N | Reproducible verified release | One clean command emits tests, package, checksums, SBOM, license report, and provenance declaration | specified |

## Claim gate

The complete-product claim is prohibited while any row is not `verified` or while the public behavior inventory has an unmapped item.
