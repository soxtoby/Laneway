# Registered Worktree lifecycle

Behavior contract for [SOX-133](https://linear.app/soxtoby/issue/SOX-133/implement-registered-worktree-lifecycle-and-worktree-backing), confirmed for implementation on 2026-09-12.

## Agreed behavior

- A branch-only column's header offers existing worktrees by name, path, and current branch, plus New worktree. It does not silently select a destination.
- Worktree Backing occupies one compact row. Edit the directory name inline; the switch icon opens the existing searchable branch popup. Overflow contains removal, unlock, and repair actions as applicable; New worktree belongs only in a branch-only column's checkout picker. There is no collapsible worktree panel or commit-ID input.
- Opening a checked-out branch focuses its existing column. Explicitly switching another worktree to that branch, including dragging the branch onto its header, offers to move it and identifies both affected worktrees before confirmation. This revises SOX-109's occupied-branch drop behavior.
- Moving a branch from worktree A to B stashes A's Working Changes against that branch, then leaves A clean and detached at its existing commit. The existing stash-before-checkout rule also applies to B's outgoing state.
- Creating a new worktree for an already checked-out branch offers to move the branch into the new worktree using the same stash-and-detach behavior.
- Checking out a branch never automatically applies its existing stashes. They remain Branch Markers until explicitly applied.
- Removing a missing worktree unregisters it without deleting a directory. Preserve surviving Git state through ordinary undo/redo checks and offer a branch for Worktree-only Commits; unavailable file contents cannot be recovered. This is low-priority behavior, not a separate recovery system.
- When an external rename or checkout can be matched to the same worktree, preserve its column position, width, and collapse state while updating its path or branch. If an external checkout collides with an existing branch-only column, retain the worktree's column and remove the redundant branch-only column; transfer focus to the retained column if the removed column had focus.
- New linked worktrees use `<repository>.worktrees/<branch-slug>` beside the Main Worktree, with the previously agreed numeric suffix for collisions. Show the resulting path during creation. A configurable global Worktree Home is deferred, revising SOX-122.
- Git worktree locks block rename/removal, not branch switching or detaching a former holder. Show the lock reason.
- Undo must restore the removed worktree's Git state under the existing recovery contract. Restoring its column's former position, width, and collapse state is optional: do it only if it fits the existing undo/redo mechanism easily, without reverting unrelated layout changes. Do not add recovery machinery solely for presentation restoration.

Existing protections and preservation rules in CONTEXT.md and SOX-122 continue to apply unless explicitly revised here.

## Engine and recovery

`workbench-engine worktree --request '<JSON>'` accepts create, switch, rename, repair, remove, and unlock requests. Create chooses a local `branch` or immutable `commit`; switch takes `path`, `branch`, and explicit `move` authorization for an occupied branch. Removal takes `preserve` and `allowIgnoredLoss`; the desktop always permits ignored-file deletion without showing or enumerating ignored files. The desktop highlights Working Changes and Worktree-only Commits instead. It then supplies `--expected <token>` to reject changed inputs. These operations share the existing repository lock, journal, and linear undo/redo history.

Undoing removal can use `undo --worktree-basename <name>` when the original directory is occupied; the UI offers the same choice. Column presentation is reconciled from Git and current Workspace State rather than added to the recovery journal. `virtualBranchPrefix` in application settings controls protective branch names and defaults to `worktree/`.

File bytes, symlinks, index compatibility state, HEAD, registration, and affected submodule administrative state are retained as Git objects. Ignored files are excluded. Directory rename undo/redo moves the directory so ignored files survive; undo that would delete newly present ignored files refuses and asks the user to move them first.

Recovery finalizes recorded target states and safely cancels an interrupted operation whose original state still matches. A crash or external edit during a filesystem transition can leave neither recorded state matching: recovery stops with the operation ID and retained recovery refs for inspection, without forcing an overwrite. Git worktree changes are not globally atomic filesystem transactions.
