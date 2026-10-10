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
difference between stash apply and pop. Undo uses operation-specific records:
commit refs, staging indexes, branch refs/metadata, and stash entries/affected files.
Git execution takes no Laneway repository lock and has no interruption-recovery
transaction. Only the completed result's history write is coordinated. An
interruption before that write may leave an unrecorded Git action. Undo validates
the affected state and retains the objects it needs; commit undo leaves the index
and working files alone. Complex Laneway workflows retain their checkpoint and
recovery machinery. Laneway does not reimplement Git's option parsing or behavior.
Native stdin remains available to Git and its editor. Global Laneway options precede
wrapper commands to avoid consuming Git arguments or filenames.

This refines ADR 0003: basic equivalents are retained specifically for participation
in operation history. The existing desktop JSON transport remains supported for
precise UI snapshots and large selections, alongside the ordinary arguments required
by ADR 0001. Desktop UI policies are unchanged.

See [the command reference](../cli.md) for syntax and journal limitations.
