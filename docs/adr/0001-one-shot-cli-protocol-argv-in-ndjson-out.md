# One-shot CLI protocol: argv requests, NDJSON responses, no envelope versioning

The Laneway Engine is invoked as a fresh process per command by the GUI, people, and agents (per SOX-107). Requests are ordinary CLI arguments; stdout carries NDJSON results and progress events when `--json` is passed, human-readable text otherwise; stderr is always free-form human diagnostics. We deliberately dropped an earlier idea of versioned JSON request envelopes with in-band protocol negotiation: GUI and CLI ship together, so mismatched majors are not a realistic failure mode, and a one-shot process has nobody to negotiate with. Compatibility is checked out-of-band via `--version` before spawning when a caller needs assurance.

## Considered Options

- Version field on every message envelope with major-gated rejection — rejected as ceremony without a real consumer of the guard.
- Length-prefixed frames or a handshake — rejected: harder to test from any shell, no benefit at these message sizes.
- argv-in/NDJSON-out (chosen) — trivially hand-testable, streaming-capable for progress events.

## Consequences

Stable dotted error codes (`usage.invalid-argument`, `engine.internal`, …) plus exit codes (`0` ok / `1` failure / `2` usage / `3` cancelled) are the compatibility contract between callers and the Engine, owned by the shared package; they must change conservatively once external agent callers exist.

The native Git wrappers introduced by [ADR 0018](0018-expose-terminal-workflows-and-undoable-git-wrappers.md) preserve Git's exit code after Git runs. Their `--json` result includes that code and Git's output; Laneway setup failures still use the Engine error contract.
