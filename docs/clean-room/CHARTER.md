# Clean-room charter

## Objective

Build an independently authored product that satisfies documented user-visible behavior while using an original architecture, vocabulary, interface, and codebase.

## Honest boundary

The specification lead inspected a third-party reconstruction before this repository was created. That person may write requirements, risk statements, and black-box acceptance criteria, but must not contribute implementation code derived from that inspection.

Implementation work must be performed by an isolated builder who receives only:

- files under `docs/spec/`;
- official public standards and provider documentation;
- original product decisions written in this repository; and
- test fixtures authored specifically for this project.

The isolated builder must not open, search, extract, diff, or import the reference archive.

## Allowed provenance

| Code | Meaning | Allowed use |
|---|---|---|
| `U` | Direct user requirement | Requirements, design, implementation, tests |
| `O` | Publicly observable product behavior | Behavioral requirement and black-box test only |
| `S` | Official public standard or provider API | Contract design and implementation |
| `N` | Original BotBotBot safety or quality improvement | Design, implementation, tests |

## Forbidden provenance

The following are not allowed in implementation commits:

- code, prompts, internal strings, constants, symbols, filenames, tests, assets, or configuration copied or translated from the reference archive;
- binary patching or runtime dependency on an upstream application;
- reconstructed internal architecture used as an implementation blueprint;
- upstream trademarks or a confusingly similar visual identity; and
- claims that absent evidence proves independence.

## Roles

- **Specification lead:** owns requirements and black-box evidence; does not author product code.
- **Isolated builder:** authors product code from approved specifications only and signs `BUILDER_DECLARATION.md` for each implementation tranche.
- **Verifier:** checks behavior, provenance, license inventory, secrets, and similarity without supplying implementation details back to the builder.

One person or agent must not switch from verifier/specification work to implementation work within the same contaminated context.

## Required evidence per feature

Every feature row must link to:

1. requirement ID and allowed provenance code;
2. independent design decision or applicable public standard;
3. implementation owner declaration;
4. automated or reproducible black-box acceptance test; and
5. release gate status.

## Completion rule

“All features implemented” is false until the public-surface inventory is complete, every feature is mapped, unclassified behavior is zero, and all tests and provenance gates pass. Partial milestones must be labeled partial.
