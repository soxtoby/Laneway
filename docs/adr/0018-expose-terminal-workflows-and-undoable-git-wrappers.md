# Expose terminal workflows and undoable Git wrappers

The public `lane` interface uses commands, positional arguments, options, and help.
People should not construct JSON requests, resolve object IDs themselves, or carry
preview tokens between invocations. `--json` selects machine-readable output.

`move`, `copy`, `rebase`, `reword`, `worktree`, `pull`, conflict management, and
operation history expose Laneway workflows. The CLI resolves revisions and worktree
paths and performs the preview/apply protocol internally, retaining stale-state
checks and explicit approval for published rewrites, removed commits, and conflicts.

`commit`, `stage`, `unstage`, `branch`, and `stash` are thin wrappers over system Git.
They preserve Git arguments and semantics, including staged-only commits and the
difference between stash apply and pop. Laneway adds locking, checkpoints, and
undo/recovery; it does not reimplement Git's option parsing or commit behavior.
Native stdin remains available to Git and its editor. Global Laneway options precede
wrapper commands to avoid consuming Git arguments or filenames.

This refines ADR 0003: basic equivalents are retained specifically for participation
in operation history. The existing desktop JSON transport remains supported for
precise UI snapshots and large selections, alongside the ordinary arguments required
by ADR 0001. Desktop UI policies are unchanged.

See [the command reference](../cli.md) for syntax and journal limitations.
