# First vertical slice

## Outcome

A user can send a message, route the turn through a provider adapter, receive a tool proposal, approve or deny the exact action, continue the turn with the result, and reload the complete timeline without loss.

## Required modules

1. **Domain contracts** — workspace, conversation, message, provider, tool manifest, proposal, approval, execution receipt, and audit event.
2. **Durable journal** — one writer, global monotonic sequence, hash chain, fsync-before-acknowledge, strict replay, explicit corruption error.
3. **Provider router** — registered adapters, declared capabilities, explicit selection, one shared conversation history, deterministic fallback policy.
4. **Tool policy** — effect-based decisions and one-use approvals bound to canonical arguments.
5. **Runtime coordinator** — turn lifecycle, streaming, cancellation, tool pause/resume, and budget enforcement.
6. **Desktop-facing UI** — conversation rail, timeline, provider control, and decision ribbon.

## Event contract

The journal records immutable events. At minimum:

- workspace created;
- conversation created;
- user message accepted;
- provider selected;
- assistant stream started, advanced, completed, or cancelled;
- tool proposed;
- policy decided allow, ask, or deny;
- approval granted, denied, expired, or consumed;
- tool execution started, succeeded, failed, or became uncertain; and
- turn completed or failed.

Every event includes an event ID, global sequence, workspace ID, conversation ID where applicable, actor, timestamp, payload schema version, previous hash, and current hash.

## Policy behavior

- Pure in-process computation with no external read may be allowed by manifest.
- External reads require a declared host/data scope and may be allowed only when the user granted that scope.
- Writes, deletes, messages, credential operations, purchases, financial actions, and local execution default to ask.
- Unknown effects deny.
- An approval is valid once, for one exact proposal fingerprint, for at most five minutes.

## Acceptance tests

1. Two providers used in one conversation receive the same complete normalized history.
2. An unknown provider capability fails before network or tool activity.
3. A mutation tool cannot execute through direct, routed, retry, or resume paths without an approval.
4. Approval argument, actor, conversation, expiry, and replay mismatches all deny.
5. Two hundred concurrent appends across multiple conversations retain every unique event in global sequence.
6. Forced truncation and checksum mutation produce a corruption error and preserve the journal.
7. Restart reconstructs exactly the previously acknowledged timeline.
8. The UI exposes the causal chain from provider to policy to approval to receipt.

## Done gate

The slice is done only when implementation, unit tests, concurrency tests, corruption tests, UI build, and a rendered visual review all pass from a clean checkout.
