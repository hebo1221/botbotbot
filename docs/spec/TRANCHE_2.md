# Tranche 2 — persistent agents and human direction

## Outcome

A user can create a persistent agent profile, organize agents into original workspace sections, react to messages concurrently, and steer or stop running work without losing history, deleting agents, or accepting late provider output.

This tranche implements `ONB-001`, `CONV-002`, `CONV-003`, `AGT-003`, and `ORG-001` at the local control-kernel level. Cross-device synchronization remains a later tranche.

## Clean-room sources

- `U`: the full user objective and BotBotBot product principles.
- `O`: original product behavior specified in `PRODUCT.md` and the feature matrix.
- `N`: original concurrency, authority, recovery, and interface improvements below.

No reference code, naming, copy, assets, internal event contracts, or UI layout may be consulted.

## Agent profile behavior

An agent profile contains:

- stable agent ID and workspace ID;
- user-chosen display name and short role title;
- original BotBotBot visual token: one approved color token and one abstract mark token;
- status: `idle`, `working`, `waiting_for_human`, `stopped`, or `error`;
- created and updated timestamps; and
- monotonic profile revision.

Create and update commands require a human actor and a unique client request ID. Empty or oversized names/titles, unknown visual tokens, invalid status transitions, duplicate IDs, and stale expected revisions fail before any event is written. Replaying the same client request returns the original result.

## Section behavior

- Sections belong to one workspace and have stable IDs, user-facing names, order keys, and revisions.
- An agent belongs to zero or one section. Zero means unassigned; unassigned is a projection, not a special persisted section.
- Create, rename, reorder, assign, unassign, and delete commands are durable and idempotent.
- Deleting a section atomically projects every member to unassigned and never deletes or edits an agent profile.
- Cross-workspace membership is rejected without revealing the foreign agent or section.
- Concurrent commands use expected revisions. One valid serialization wins; stale commands return an explicit conflict rather than silently overwriting.

## Reaction behavior

A reaction identity is `(workspace, conversation, message, human actor, reaction token)`.

- Setting present/absent is idempotent; it is not an ambiguous toggle command.
- Reaction tokens come from a small original allowlist for this tranche.
- A reaction requires an existing message in the same workspace and conversation.
- Concurrent reactions on different identities all survive; competing writes to one identity resolve by journal sequence without deleting unrelated reactions.
- Restart reconstructs the exact reaction set.

## Steering and stopping

### Stop

1. Authenticate a human control request and durably record it before signalling the provider.
2. Bind it to workspace, conversation, active turn, client request ID, and current direction epoch.
3. Abort the active provider request.
4. Record the terminal stopped outcome once.
5. Ignore and never commit provider chunks arriving from the retired epoch.

Repeated stop requests return the original receipt. A stale turn/epoch request cannot stop newer work.

### Steer

Steering is a durable follow-up direction, not mutation of prior user text.

1. Record the human direction and client request ID.
2. Retire the active direction epoch and abort its provider stream.
3. Record the old phase as steered/stopped without committing late chunks.
4. Start a new provider phase from the complete durable conversation plus the new direction.
5. Preserve one conversation and one visible causal timeline.

If no turn is active, a steer command becomes a normal durable follow-up message. Duplicate steer IDs never create a second direction or provider request.

## Events

Add independently named immutable events for:

- agent created and profile updated;
- section created, renamed, reordered, deleted;
- agent section assignment changed;
- reaction state set;
- human control requested;
- direction accepted; and
- turn stopped or steered.

Every new payload receives strict runtime and replay validation. User text is bounded and stored only where it is part of the visible conversation; audit-only control events carry hashes/summaries where raw data is unnecessary.

## UI behavior

- The rail groups agents by section and always exposes an unassigned group when needed.
- Profile and section controls use injected control-service ports and change visible state only after a matching durable receipt.
- Running, waiting, stopped, and error states are distinguishable without color alone.
- A running conversation presents “Steer” and “Stop” with the exact target turn; disconnected controls are disabled and explanatory.
- Reaction controls announce current state and remain keyboard operable.

## Acceptance tests

1. Agent create/update survives restart; duplicate client IDs return the original revision.
2. Stale profile and section revisions return conflicts with zero new events.
3. Deleting a populated section leaves every agent unchanged and unassigned.
4. Cross-workspace assignment is denied without a write.
5. Two hundred concurrent reaction state writes retain every independent identity exactly once in the final projection.
6. Same-identity reaction writes resolve by sequence and preserve all unrelated reactions.
7. Stop is durable before provider abort; late chunks after the retired epoch are absent from history.
8. Duplicate and stale stop requests create one terminal result and cannot affect a newer turn.
9. Steering retires the old phase, records the new human direction once, and gives the next provider complete history.
10. Restart after control-request persistence but before provider acknowledgement returns an explicit interrupted/resume state without duplicating the command.
11. Malformed primitive, enum, nested, oversized, and cross-scope payloads fail before write and fail closed during replay.
12. UI state changes only after matching durable control receipts; fabricated or mismatched receipts are rejected.

## Done gate

- All tests above pass from a clean checkout.
- Existing 42 tranche-1 tests remain green.
- npm audit has no critical/high findings; any lower finding is explicitly triaged.
- Desktop and 360px screenshots are reviewed with zero console errors.
- A new isolated-builder declaration lists only approved specifications and clean repository code.
- Full-product status remains HOLD.
