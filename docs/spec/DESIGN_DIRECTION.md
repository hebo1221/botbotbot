# Design direction

## Audience and job

The interface is for a person supervising several capable agents. Its single job is to make a complicated causal system understandable at a glance: who is working, what they propose, and what authority they currently possess.

## Visual thesis

**A calm control room with visible handoffs.** The UI should feel like a precise instrument, not a chat app with extra sidebars and not a generic analytics dashboard.

## Tokens

| Role | Name | Value |
|---|---|---|
| Canvas | Frosted slate | `#EEF3F8` |
| Primary text | Deep ink | `#142033` |
| Active path | Relay cobalt | `#315BEA` |
| Human decision | Warm coral | `#F26B5B` |
| Verified result | Mineral mint | `#BDEBDD` |
| Muted structure | Graphite fog | `#687386` |

Typography uses `Avenir Next` for display and navigation, `Apple SD Gothic Neo` for Korean-first body copy, and `SFMono-Regular` for identifiers, costs, and audit data. All have system fallbacks; the application does not depend on remote fonts.

## Layout

```text
┌ agent + conversation rail ┬ durable timeline ┬ authority ledger ┐
│ status and scope          │ messages/events  │ provider/budget  │
│                           │ decision ribbons │ active approvals │
└───────────────────────────┴──────────────────┴──────────────────┘
```

At narrow widths the authority ledger becomes a bottom sheet and the rail becomes a switcher. The conversation remains the stable spatial anchor.

## Signature element

The memorable element is the **decision ribbon** attached to every proposed or executed action. It draws a compact causal path:

`agent → provider → policy → human decision → receipt`

Each node is factual and interactive. Missing evidence is a broken path, never a decorative success state. Motion occurs only once when a node changes state; reduced-motion users receive an immediate state change.

## Interaction language

- Use verbs that name the actual effect: “Allow this send,” “Deny deletion,” “Stop after this step.”
- Errors state what was preserved and the next safe action.
- Empty states invite one concrete action.
- Provider and tool implementation names stay out of primary navigation unless users must choose them.

## Uniqueness review

The initial concept avoided the common dark-console/neon-agent treatment and the generic cream/editorial treatment. The visual risk is the horizontal decision ribbon: it spends visual emphasis on authority provenance rather than decoration, which is specific to this product's trust problem.

## Quality floor

- WCAG AA contrast for text and state markers;
- complete keyboard operation and visible focus;
- state never encoded by color alone;
- screen-reader labels for causal nodes and streaming state;
- responsive behavior down to 360 CSS pixels; and
- `prefers-reduced-motion` respected.
