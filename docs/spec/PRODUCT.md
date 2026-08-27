# Product specification

## Subject

BotBotBot is a trustworthy multi-agent desktop workspace for an individual or small team that wants several AI workers to share a visible workspace while retaining human control over memory, credentials, costs, and side effects.

## Single job

Turn a user message into a durable, inspectable sequence of model reasoning outputs, tool proposals, policy decisions, and results—across providers—without losing history or silently expanding authority.

## Product principles

1. **One history:** changing providers never fragments or hides the conversation.
2. **One policy gate:** every tool path passes through the same authorization engine.
3. **Least credential:** each runtime receives only the short-lived credential it needs.
4. **Visible causality:** users can see what proposed an action, what policy decided, and what executed.
5. **Fail closed, preserve evidence:** corruption, unknown tools, stale approvals, and ambiguous origins stop execution without replacing existing data.
6. **Provider independence:** public provider APIs sit behind replaceable adapters; private login files and undocumented endpoints are forbidden.
7. **Original identity:** product language, information architecture, visuals, and interaction patterns are authored for BotBotBot.

## Primary user journey

1. Create or open a workspace.
2. Start a conversation with one or more agents.
3. Select a provider or accept a transparent routing recommendation.
4. Send a message and watch durable streaming progress.
5. Inspect any proposed tool action and its risk classification.
6. Approve, deny, or narrow the exact action.
7. Receive the result, with the full causal chain stored in one timeline.
8. Restart the app and continue without history loss or authority carry-over.

## Superiority criteria

BotBotBot is better only when evidence shows:

- no approval-path bypass across providers or tools;
- no conversation loss under concurrent operations or forced shutdown;
- no broad credential-directory exposure;
- exact-origin validation for embedded or remote content;
- provider changes preserve one coherent history;
- clearer user control over cost, time, and action budgets; and
- a reproducible build that needs no upstream binary.
