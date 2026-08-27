# Security invariants

These rules are architectural, not optional hardening tasks.

## Identity and credentials

- The renderer cannot read, reveal, enumerate, or transport raw secrets.
- Provider login uses documented public OAuth/API flows and dedicated BotBotBot credentials.
- Credentials created by another application are never read or refreshed.
- Work environments receive short-lived, audience-bound credentials, never an entire auth directory.
- Secrets remain in the OS keychain; durable databases contain opaque references only.

## Tool authorization

- Every executable tool has a reviewed manifest with stable identity, effect class, data scope, network scope, and idempotency declaration.
- Unknown or incomplete manifests are denied.
- All entry paths call the same policy engine before execution.
- Side effects require a one-use approval bound to the exact canonical arguments, conversation, actor, and expiry.
- Tool names and descriptions are never used to infer whether an action is safe.
- Retries cannot reuse approval after uncertain or successful execution.

## Embedded and remote content

- A requested origin cannot authorize itself.
- Allowed origins come from an authenticated control-plane record and are compared by exact scheme, host, and port.
- A mismatch cancels attachment before a preload or privileged bridge is installed.
- Remote content is sandboxed and never receives clipboard, filesystem, credential, or process APIs directly.
- Clipboard access is directional, gesture-bound, rate-limited, and separately revocable.

## Local execution and isolation

- No global sandbox-disable flags.
- Workloads run as an unprivileged identity with a read-only root, dropped capabilities, no-new-privileges, resource limits, and explicit egress policy.
- Images and downloaded runtimes use immutable digests plus signature or checksum verification.
- Host paths are mounted individually and only after an explicit scope decision.

## Storage

- One durable writer assigns monotonic sequence numbers across all conversations.
- Every record is checksummed and chained to its predecessor.
- Appends are flushed before acknowledgement.
- Corruption raises a visible error and preserves the original bytes; it never becomes an empty database.
- Approval state and execution receipts are transactional with the conversation event that references them.

## Observability and updates

- Logs use allowlisted fields and redact payloads by construction.
- Diagnostic exports exclude prompts, secrets, raw tool arguments, and file contents by default.
- Release updates are signed, pinned to a channel, and verified before replacement.
- Security tests must exercise the bypass path, not only the intended UI path.
