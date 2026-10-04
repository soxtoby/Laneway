# Retain worktree state in Operation History

The snapshot recovery model below is superseded by [ADR 0017](0017-recover-operations-from-git-checkpoints.md). It remains supported for existing history entries.

Worktree lifecycle operations use the existing repository-wide mutation lock and linear Operation History, retaining exact file/index/HEAD and registration snapshots through private Git recovery refs. Git-native create, checkout, move, repair, and removal establish the result; a durable target checkpoint enables undo/redo, while an interrupted filesystem transition with neither source nor target matching stops for inspection. This preserves ordinary Git compatibility and avoids treating a multi-file mutation as an atomic ref transaction or forcibly replaying over external edits.

[ADR 0014](0014-retain-operation-objects-in-protected-packs.md) replaces the recovery refs with protected Git packs; the operation and safety contracts above still apply.
