# Unresolved stack and conflict recovery

This document records the desired SOX-136 behavior.

## Implementation entry points

`lane conflict --request <JSON> --json` is the shared engine entry point. `rewrite` takes affected branch names in stack order, an exact base commit ID, and an optional worktree path. It replays linear history; merge-commit topology is outside this operation. SOX-137/SOX-139/SOX-140 can call this operation when implementing their stack updates.

`list` and `inspect` supply recovery state and candidates. `choose`, `edit`, `use-file`, and `tool` save explicit candidate progress; `accept` and `keep-stashed` record undoable operations. `publish-check` supplies the guard for the future Publish operation. The renderer exposes resolution from affected branches and commit rows through typed IPC.

`inspect` with `files: []` loads the conflict inventory without constructing review trees or loading unresolved file content. Expanding an unresolved text file reads its immutable provisional or candidate blob directly through typed IPC; Pierre interprets the existing markers. Resolved-file reviews load on demand. File content is cached by repository, conflict inputs and candidate revision; inspection cache reuse checks the authoritative state and candidate refs. Branch history batches ref checks and reuses metadata by immutable object ID while still detecting changes during loading.

Authoritative state lives at `refs/laneway/conflicts/current`; candidate refs are keyed by subject and exact conflict inputs. Recovery commits retain the actual trees, blobs, and source commits so Git garbage collection cannot discard objects mentioned only in metadata. Operation History includes the authoritative state ref in worktree snapshots. Saved merge-tool files live beneath the Git common directory, outside the project tree.

Missing branches can be restored or explicitly matched to an external rename. Damaged metadata keeps Git history readable and directs recovery through Operation History; conflict acceptance remains unavailable until authoritative state is restored. Ordinary branches containing retained unresolved commits remain blocked by the publication guard even after their original stack is resolved.

Validation covers real SHA-1/SHA-256 repositories, structural and binary conflicts, dependent branches, exact-input candidate reuse, external branch edits, worktree switching, stashes, staged/unstaged preservation, Git GC, crash recovery, undo/redo, and rebuilt Electron restart/acceptance under the production CSP.

## Completed rewrites

- A rebase or stack update completes even when commits conflict. Git has a resolved index and ordinary commits; text conflicts remain as markers and may break compilation.
- The rewrite is pinned to a specific Base Branch commit. Later movement of that branch has no effect until another explicit update.
- One conspicuously named local branch, `laneway/unresolved/<tip>/<operation-id>`, holds each provisional stack tip and has no upstream. Ordinary affected branch refs remain at their last resolved tips.
- Private durable state is authoritative for each conflict's exact inputs and provisional branch boundaries. Markers alone are insufficient, and binary or structural conflicts retain their source blobs privately while keeping one provisional version in the tree.
- Laneway marks every affected Branch Node unresolved. Switching away follows normal column lifecycle and does not keep a branch-only column open solely for recovery.
- Conflicted Commits stay in the ordinary commit stack with a conflict indicator that opens resolution. The Branch Column header has the same indicator as a toggle for showing only conflicted commits; it does not move them into a separate list.
- Lower branches in the Active Stack show a conflict indicator in their section headings, including while collapsed. Expanding a branch preserves the indicator; it clears when that branch is no longer unresolved.
- The temporary branch is internal representation: Laneway omits it as an ordinary Branch Node and Command Lens result, while other Git tools continue to show the real branch.
- The temporary branch may be edited, built, tested, committed to, or updated by Laneway or another tool. Laneway follows its current history rather than preserving alternative reflog children as separate continuations.
- Laneway blocks Publish, but external Git may explicitly publish or merge the conspicuous temporary branch. If unresolved decisions reach an ordinary branch, Laneway keeps that branch marked conflicted and blocks Publish.

## Multiple branches and stacks

- One temporary tip may represent several affected branches. Private state records each provisional branch boundary.
- Final acceptance atomically advances every affected ordinary branch to its provisional boundary, switches the worktree to its intended tip branch, and removes the redundant local temporary branch. Remote refs remain untouched.
- If an affected ordinary branch gained commits meanwhile, final acceptance replays only that new work onto the provisional stack and defers any resulting conflicts normally.
- A dependent stack updates from the provisional boundary of its unresolved Base Branch, creates its own temporary tip, and records the dependency. Resolving an upstream conflict restacks every dependent provisional descendant and may defer new conflicts.
- Publish is blocked for Active Stacks containing an affected branch or depending on its provisional replacement. Independent stacks remain publishable.

## Conflict content and acceptance

- New text markers name **Before this commit** and **This commit**, with short object IDs. Stash restoration uses **Current files before restoring stash** and **Stashed changes**. Existing committed markers retain their original wording; detection uses their recorded labels, so old conflicts and saved candidates remain resolvable. Descendant commits replay over marked content; failures become additional Conflicted Commits.
- Conflict resolution is always explicit. Ordinary edits never implicitly resolve a conflict.
- Whole-file choices, temporary-file edits, merge-tool output, and **Use current file** build a durable candidate separate from the checked-out stack. A merge tool exiting successfully does not accept its result.
- Conflict resolution lives in the branch column, inside the conflicted commit's ordinary file list. Conflicted files expand a merge view instead of the normal diff; other files retain normal inspection. Each file offers **Use version before this commit**, **Use this commit**, and **Merge tool**. Selecting a text file expands Pierre's merge resolution with **Keep this** beside each source label and a separate **Keep both** action. Pierre's native placement is preserved: **Before this commit** appears above its content and **This commit** below its content. The former means destination files including earlier commits in this stack; the latter identifies the replayed commit, with its original title and short commit ID. Working Changes conflicts use **Current files** (before restoring the stash) and **Stashed changes**, with **Use pre-stash version** and **Use stashed changes** actions. These display labels replace internal marker messages without modifying stored conflict content.
- Each Pierre choice immediately saves the candidate, including partial resolution. The view advances only after saving succeeds. Resolved files show the normal commit-style diff against the version before this commit (or stash restoration). **Discard progress** restores the original conflict content; **Accept resolution** remains an explicit action on the commit, enabled once all its conflicts are resolved. Custom text editing uses the external merge tool.
- Partial candidates survive closing and restart. Acceptance requires explicit resolution content for every recorded region and no Laneway markers remaining in the candidate.
- Conflicted Commits may be accepted in any order. Accepting one is a Laneway Operation that rewrites it and restacks descendants. Changed downstream inputs reopen their conflicts and retain old results only as suggestions.
- Binary and structural source versions are materialized as named temporary files for inspection or an external merge tool, never invented as sibling project files.
- Binary and structural files retain whole-file and external-tool actions. Pierre merge controls support regular text files up to the conflict preview limit. V1 has no AI resolution action.

## Working Changes conflicts

- Branch switching auto-stashes Working Changes on the old branch and does not apply them to the destination.
- A Working Changes Conflict begins only when an explicit stash application or restoration cannot apply cleanly to a clean worktree. The operation completes with named markers as ordinary uncommitted files and a resolved index.
- The original stash remains until resolution. Acceptance writes Working Changes, consumes the ordinary stash, and retains private undo state. **Keep stashed** restores the destination's pre-application state and leaves the stash unchanged.
- Publish remains blocked for the affected stack until acceptance or **Keep stashed**.
- Acceptance and **Keep stashed** are separate Laneway Operations. Undo restores the preceding unresolved state.

## Operation History and cleanup

- The stack rewrite and each accepted conflict resolution are separate Laneway Operations. Partial resolution work is durable state, not an operation.
- Later Laneway operations must be undone before the rewrite that created their Unresolved Stack. An unrecorded external mutation may create the ordinary external-change boundary.
- Undoing the rewrite restores its prior branch refs and worktree and removes its temporary branch. Accepting the final conflict performs final branch advancement and local temporary-branch cleanup.
- Collapsing a commit or closing its branch column preserves resolution progress. Explicit cancellation discards only that candidate and leaves the conflict unresolved. There is no special paused-rebase Abort or Reset action.

## Restart and missing branches

- Restart restores valid Unresolved Stacks and durable candidates while following normal Workspace State. Resolution progress survives restart; commits and files follow normal inspection expansion behavior, with no separate resolution column to restore.
- If another tool deleted the temporary branch but private recovery refs still retain its commits, Laneway does not silently recreate it. Affected Branch Nodes show recovery is required and offer **Restore unresolved stack** or **Discard unresolved update** after showing what each action retains.
- If authoritative conflict metadata is missing or corrupt, marker text is not used to reconstruct it. Laneway keeps the temporary branch usable, blocks final acceptance and Publish, and offers recovery from durable journal/private-ref state or explicit conversion to a normal branch with conflict recovery abandoned.
- If the expected temporary branch disappears and another branch appears at the same tip, Laneway shows it as a possible external rename but requires confirmation before adopting it; equal commit IDs do not establish branch identity.
- Switching away from a Working Changes Conflict follows normal auto-stash behavior. Laneway stashes the marked files with their durable conflict association, marks the source branch as having a suspended Working Changes Conflict, and retains the original unapplied stash until acceptance or **Keep stashed**.
