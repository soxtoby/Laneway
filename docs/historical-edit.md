# Historical Edit

The settled behavior for [SOX-139](https://linear.app/soxtoby/issue/SOX-139/implement-historical-edit), from the SOX-123 prototype decisions of 2026-08-22.

## Accepted decisions

### Entry and composition

- Historical Edit is an explicit, per-worktree checkout context for editing from an older snapshot. It isn't a special one-commit workflow.
- **Entry.**
  - It is available for a commit unique to the focused Active Stack when the column has existing Worktree Backing. A branch-only column must first gain that backing.
  - It preserves tracked, staged, and untracked Working Changes, checks for checkout collisions first, and detaches the same worktree at the selected commit.
  - It never creates another worktree or Workspace Column, and it creates no operation.
  - Ignored files are untouched and outside undo.
  - Populated submodules block entry.
- **Composition.**
  - New Historical Working Changes use every normal composition target: the materialized commit, other eligible commits, branches, Working Changes, and new-commit seams.
  - Apply changes is the default action. It moves the current selection, or every committable change, into the materialized commit. It doesn't end the session.
  - The rewritten commit keeps its original author, authored time, and message. It uses the current committer and time, and the current hooks and signing.
  - Each Apply or drag is its own Workbench Operation.

### Conflicts and return

- **Conflicts.** A descendant replay conflict creates the ordinary Unresolved Stack and pauses the session.
  - The leftover Historical Working Changes stay in place. The session resumes at the rewritten commit once the stack resolves.
  - The original Working Changes are restored only after commit conflicts.
- **Return.** Return to `<original branch>` targets that branch's current tip and is always offered.
  - A clean session returns immediately. With Historical Working Changes left, the user chooses Drop, Bring along, or Cancel.
  - The original Working Changes restore first, then the historical ones. Each restore conflict is a distinct Working Changes Conflict.
  - Kept historical changes become a stash on the branch, labelled with their historical base.
- **Recovery and concurrency.**
  - The session, its pinned refs, the original stash, and its checkpoints are journaled.
  - Each worktree may hold its own session, while mutations stay serialized.
  - When pinned refs move, only that session becomes stale and offers Restart on latest or Return.
  - Publication stays blocked during unresolved conflicts.
- **Undo.** Checkout alone creates no operation.
  - Apply, drag, Drop, and Bring along are ordinary Workbench Operations.
  - Undo restores their recorded before-state, which may reopen the session. Redo requires its recorded precondition.

## Implementation

### Commands and session state

`lane edit --request <JSON> --json` is the desktop's entry point. Its actions are `enter` (`path`, `commit`), `return` (`path`, `mode`: `clean`, `drop`, or `bring`), `restart` (`path`), and `status`. Every result lists the current sessions.

The CLI offers the same actions as `lane edit enter|apply|return|restart|status`. Apply has no request of its own: it is a `compose` transfer whose target is the commit `{ objectId: <materialized>, branch: <original> }`. The desktop's existing transfer IPC carries it, and so do drags to other destinations.

Each session is stored in its own private ref, `refs/laneway/historical-edits/<worktree-id>`.
- The ref points at a retained document commit, like the conflict state. It holds `state.json`, and its parents keep the materialized commit, the pinned tip, the selected commit, and the original stash reachable through garbage collection.
- The document records the original branch, its pinned tip, the selected commit, the materialized commit, the original stash, and the temporary branch of an Unresolved Stack pausing the session.
- `readHistoricalEdits` in the Git module adds each session's state, `active`, `paused`, or `stale`, with a reason. The desktop reads it in-process.

### Entry, Return, and Restart

Operation checkpoints include `refs/laneway/historical-edits/`. Undoing an Apply, Drop, or Bring along therefore restores the session ref with the worktree and branches, and so reopens or rewinds the session without special handling.

Entry, a clean Return, and Restart run inside a journaled checkpoint that is never recorded in Operation History. An interruption rolls them back on the next Engine run, and success adds no undo entry.

- **Entry** stashes Working Changes as an ordinary stash on the original branch, labelled `Working Changes before Historical Edit`, so they show as its Branch Marker. It then checks out the commit detached.
- **Return** stashes the Historical Working Changes, or discards them for Drop. Next it switches to the branch's current tip, then restores the original stash. When the stash restores cleanly it is applied with its index and consumed; otherwise it becomes a Working Changes Conflict. Finally, Bring along restores the historical stash the same way.
  - Historical changes restored over the original ones arrive unstaged.
  - If the original stash conflicted, the historical stash waits on the branch as `Historical Working Changes from <commit> <subject>`, because a worktree holds one active Working Changes Conflict at a time.
  - A historical restore conflict over restored original changes records those files, so Keep stashed returns to them.
- **Return refuses** while the session is paused, when the branch is gone or checked out in another worktree, and when the detached HEAD has commits no branch or tag holds.

### Staleness, conflicts, and other operations

- **A session follows compositions.** A session worktree takes part in every composition that rewrites its original branch, wherever the composition was started. Its HEAD follows the materialized commit's rewrite, and the session's pin moves in the same ref transaction. A rewrite that would leave the materialized commit itself conflicted is refused.
- **Any other movement makes the session stale.** That includes external Git, a `lane commit` in another worktree, a branch rename or deletion, and a HEAD moved outside Laneway. Composition refuses a stale session.
- **Restart on latest** re-pins the session when its HEAD is still part of the branch. Otherwise it explains that Return with Bring along is the way forward.
- **Pausing and resuming.** When Apply creates an Unresolved Stack, the session records the stack's temporary branch and is `paused`. The worktree stays at the materialized commit, which can't itself conflict when changes are applied to it, so resolving the stack inline needs no checkout. When the temporary branch is gone and the commit is still on the branch, the session is active again.
- **Pull latest** skips any stack that contains a session's branch, along with stacks overlapping it. A shared Base alone doesn't count as overlap.
- **Worktree operations.** Worktree switch and removal refuse a worktree in a session. File extraction defers to the general planner whenever a session exists.

### Desktop

- **Reading sessions.** The Branch Graph read projects sessions in-process, as it does the conflict state. A session's detached worktree joins its original branch's `checkedOut` instead of becoming a Virtual Branch, so the column keeps its identity and Active Stack. The worktree carries the session and the edited commit's subject. If another worktree checks out the original branch meanwhile, which Git allows, that worktree keeps the branch's column and the session shows as a Virtual Branch.
- **Entering.** A commit row's menu offers **Edit from here** in a worktree-backed column outside a session, for a single-parent commit on a local branch other than the Primary Branch. The Engine checks the rest. Branch-only columns don't offer it.
- **The column in a session.**
  - A banner says "Editing from <subject> on <branch>" and offers **Return to <branch>**. A paused session shows why and waits. A stale one shows why and adds **Restart on latest**.
  - **Apply changes** replaces Commit…. It moves the lines chosen in one diff, otherwise the chosen files, otherwise everything, as an ordinary `compose` transfer into `{ objectId: session.commit, branch: session.branch }`. Its review, when composition needs one, shows in the banner.
  - Drags use every ordinary destination. The edited commit's row is marked **Editing**.
  - The `Working Changes before Historical Edit` stash shows as the session's marker without Apply or Drop, because Return restores it.
- **Returning.** Return reads the worktree's Working Changes afresh, from its current path, to decide. A clean return goes at once. With Historical Working Changes left, or when they can't be read, a dialog offers **Drop**, **Bring along**, or **Cancel**, because the choice blocks progress. Drop and Bring along are recorded operations, so their notice offers Undo. Entry, a clean return, and Restart record nothing and offer no Undo.
- **IPC.** `edit:operation` runs `lane edit --request <JSON>`. Apply uses the existing `local:operation` transport.

## Known limits

- **Paused sessions don't check out the temporary branch.** The contract has the column check out the Unresolved Stack's temporary branch while paused. This release keeps the worktree at the materialized commit instead.
- **Restart doesn't follow external rewrites.** It doesn't look for the edited commit in history that was rewritten outside Laneway.
- **Branch renames don't carry over.** Renaming the original branch, even through Laneway, makes its session stale rather than following the rename.
- **Removing a missing worktree leaves an inert session ref.** That ref reports the session stale.
- **Apply's Operation History entry is the generic "compose".** Undo works, but the entry doesn't name Historical Edit.
