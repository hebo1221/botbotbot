# Architecture

## Governing idea

Models propose effects; they never possess authority. Every action follows one observable chain:

```text
intent → prepared effect → policy decision → capability grant → execution → receipt
```

The grant is a single-use capability bound to principal, workspace, conversation, turn, stable tool identity, tool schema hash, canonical arguments hash, target scope, policy version, expiry, nonce, and maximum use count.

## Process boundaries

| Boundary | Responsibility | Explicitly unavailable |
|---|---|---|
| React renderer | Display state and collect user intent | Raw secrets, filesystem, shell, arbitrary HTTP, clipboard read, executor access |
| Minimal native shell | Window lifecycle and trusted native confirmation | Provider tokens and tool implementation |
| Control service | Conversations, routing, budgets, policy, durable state | Direct UI trust and arbitrary remote content |
| Credential broker | OS-keychain handles and scoped request signing | Secret reveal APIs |
| Provider workers | One documented provider API per worker | Other providers, keychain enumeration, tool execution |
| Tool gateway | Prepare effects, validate grants, invoke executors, emit receipts | Bypass imports and model-defined safety classes |
| Compute supervisor | Rootless isolated workloads and patch export | Host home, auth directories, Docker socket, unrestricted egress |
| Remote-display worker | Parse encrypted framebuffer protocol into bounded frames | HTML/JavaScript execution and host clipboard access |

The initial vertical slice may run the control modules in one local process, but module APIs and tests must preserve these boundaries so they can move into isolated processes without changing behavior.

## Remote display

Privileged webviews are forbidden. Remote desktop data is decoded by a separate memory-safe worker into bounded pixel frames rendered on a canvas. Clipboard inbound and outbound use separate gesture-bound grants through the tool gateway.

## Provider and MCP adapters

- Provider integrations use published APIs and dedicated BotBotBot authentication only.
- Each adapter declares a capability document before a turn starts.
- Managed connectors translate operations into canonical prepared effects.
- Arbitrary MCP servers run isolated and are `unknown/high-risk` until a local reviewed policy assigns an effect class.
- Server-supplied read-only or risk annotations are advisory data, not authorization.
- Schema or server identity changes revoke outstanding grants.

## Durable execution

Conversation state and external effects use an outbox/receipt model:

1. transactionally record prepared effect and pending execution intent;
2. execute with an idempotency key where supported;
3. record a receipt and commit the projected result;
4. after ambiguous failure, mark `outcome-unknown` and require reconciliation instead of blind retry.

The first slice uses an append-only hash-chained journal to prove ordering and recovery behavior. Production promotion adds a transactional SQLite projection with one writer, WAL, and full synchronous durability while retaining the journal as an audit stream.

## Dependency direction

```text
UI → application ports → domain kernel
provider adapters ────────┘
tool adapters → tool gateway → policy kernel
storage adapters → journal/projections
native shell and workers → narrow authenticated ports only
```

Domain and policy modules do not import UI, provider SDKs, MCP transports, native shell code, or executor implementations.
