# Pull latest

Desired user-facing behavior for [SOX-137](https://linear.app/soxtoby/issue/SOX-137/implement-pull-latest-for-open-active-stacks). Shared understanding confirmed on 2026-09-20; implementation landed the same day.

## Accepted decisions

- Pull latest incorporates incoming changes from each stack branch's upstream, then synchronizes the stack onto its updated Base. Fetched tips remain frozen for the operation.
- An open Active Stack includes its intermediate branches even when they have no Workspace Column. Branches outside all open stacks remain untouched. Local Base Branches retain the existing fast-forward-only rule; diverged Bases are never reset or rewritten automatically.
- Working Changes are automatically preserved and reapplied in their original worktrees. Reapplication conflicts use deferred recovery; independent stacks continue. The existing Working Changes Conflict contract applies: accepted resolutions become Working Changes, not commits.
- When a feature branch and its upstream both advance, replay local-only commits onto incoming history, preserving merge topology and deferring conflicts normally.
- Adopt a force-pushed upstream automatically only when unpublished local work can be reliably distinguished from replaced history. Otherwise leave the affected stack unchanged and explain the explicit decision required.
- A diverged Base blocks synchronization of stacks based on it. Show "Base has diverged" and continue independent stacks; never silently bypass the local Base.
- Pull latest may update an already Unresolved Stack onto newer fetched history. Preserve resolutions whose inputs remain unchanged; reopen affected conflicts and retain previous resolutions as suggestions.
- Fetch the selected remote and every other remote needed by the open Active Stacks, once each.
- Activating Pull latest starts immediately, with progress and per-stack outcomes. Decisions that cannot be made automatically leave the affected stack unchanged with an explanation.
- Freeze scope at activation, including collapsed Workspace Columns. Opening or closing columns during execution affects the next pull, not the current operation.
- Cancellation stops at the next safe boundary, retaining completed updates and preserved edits. Report what completed and what remains.
- One Undo reverses the pull's completed local changes across stacks, including restored Working Changes, when replay preconditions remain valid. Fetch results remain available.
- If a required fetch fails, skip stacks that depend on it with an actionable error; continue stacks whose required fetches succeeded. Never substitute stale fetched history.
- A branch without an upstream still synchronizes onto its Base. A configured upstream that has disappeared is treated the same way: there is nothing to incorporate, nothing to report, and Laneway never silently recreates its remote branch.
- Recheck inputs before applying changes. If concurrent file edits or ref movements invalidate preparation, leave the affected stack untouched by this pull and report "Changed during pull—retry"; independent stacks continue.
- Skip the overlapping stack group containing an active Historical Edit, preserving that session; independent stacks continue.
- Existing Working Changes Conflicts do not prevent an update. Preserve edits and conflict tracking, retain progress where inputs match, and reopen changed conflicts with earlier resolutions available as suggestions.
- Place Pull latest in the repository header alongside Undo/Redo. Show fetching/updating progress and Cancel; prevent duplicate pulls while running.
- When every stack updated cleanly or was already current, confirm with a passing notice only. Otherwise show a compact repository outcome summary, expandable by stack: Updated, Already current, Needs resolution, Skipped, or Failed. Explain skips and failures, link conflicts to inline resolution, and keep publication pending visible on affected branches.
- After interruption, safely recover interrupted local changes without automatically continuing the pull. Retain completed updates, conflict progress, and the pull's single Undo entry; explain anything recovery cannot safely finish. Continuing requires another explicit Pull latest.
- With no remotes, disable Pull latest and show "Add a remote to pull." With no open stacks, allow fetch-only and report "Fetched; no open stacks to update." A pull with no local changes creates no Undo entry.
- When an upstream rewrite cannot be adopted safely, offer inspection of local and upstream history and explain that Laneway cannot identify which local commits to retain. The user reconciles through explicit history operations, then retries; never automatically reset or guess which commits to replay.

## Existing policy

- Pull latest is repository-scoped and never publishes. Rewritten publication remains pending.
- Overlapping stacks synchronize as one unit; independent stacks may complete separately.
- Unknown or ambiguous Bases block automatic synchronization of the affected stack while leaving inspection available.
- Commit conflicts produce durable Unresolved Stacks using the [existing recovery contract](unresolved-stack-recovery.md).
- Local mutations remain undoable when their preconditions remain valid.

## Implementation

`lane pull --request <JSON> --json` is the Engine entry point. The request carries the open Workspace Column branch refs, frozen by the renderer at activation, and the selected remote. Progress events name each fetch and each stack update; the result lists fetch outcomes and one outcome per stack: `updated`, `current`, `needs-resolution`, `skipped`, `failed`, or `cancelled`, each with an explanation.

Fetching runs before the repository mutation lock so a slow network never blocks other Laneway Operations. Laneway fetches the selected remote and every upstream remote used by scoped stacks once each, with pruning. Fetch results are never part of the undoable operation, so what a branch last pulled has to outlive the fetch (`cli/src/pulled-upstreams.ts`). When a fetch moves a branch's upstream, Laneway records the tip it moved from in `branch.<name>.lanewayPulledUpstream`, unless an earlier fetch already did, and forgets the records of branches that have since caught up. It does so under the mutation lock but outside any operation, ignoring cancellation, whether or not the pull goes on to update anything. Updating a stack compares each upstream with its record, or with its remote-tracking tip when there is none, to tell a force-pushed upstream from ordinary advancement and to recognize local history rewritten since the last pull; it clears an updated branch's record inside the operation, so Undo restores it and a later pull incorporates the same commits again. Native undo and checkpoints ignore these keys, as they do the upstreams Publish records.

Active Stacks are derived from Branch Graph Base inference. When two branches that diverged from each other name one another as Base, the stack continues below the loop through the next closest branch outside the chain; an ambiguous Base skips the stack. Longer chains process first, so overlapping stacks synchronize their shared prefix once and the shorter stack reports the shared result.

Synchronization reuses the SOX-136 stack rewrite. `rewriteStack` accepts explicit replay sources per branch: incoming upstream commits first, then local-only commits, with `git cherry` dropping local commits whose patch is already upstream. A Base fast-forward is a rewrite with no sources, so worktrees holding the Base carry their Working Changes through the same replay and defer reapplication conflicts as Working Changes Conflicts. Existing Unresolved Stacks receive incoming commits as inserted steps and move to the new Base; conflicts whose inputs are unchanged keep their candidates, and changed conflicts keep earlier results as suggestions. Existing Working Changes Conflicts on a moved worktree are re-based onto the new HEAD so acceptance and Keep stashed remain available. A stack is already current only when nothing arrived and each branch already sits on its parent's tip, so a Base that moved before the pull, including a remote-only Base, still restacks it.

Every stack update happens inside one `pull.latest` Laneway Operation, giving one Undo entry across stacks; a pull that changes nothing records no entry. A stack failure before it changes any ref is reported and the pull continues; a failure after refs changed stops the operation under the normal recovery contract. Cancellation is checked between fetches and between stack runs.

Known limits in this release: replay is linear, so stacks whose commits include merges are skipped with an explanation rather than replayed with merge topology; a fetch by another tool records nothing, so when it moves the upstream of a branch that has diverged, the upstream's new commits look already pulled and are not incorporated. A stack holding a Historical Edit, and any stack overlapping it, is skipped with an explanation.

The renderer places **Pull latest** beside Undo/Redo in the repository header. It is disabled with "Add a remote to pull." when the Branch Graph reports no remotes, shows fetch and update progress with a Cancel control while running, refuses duplicate pulls, confirms an uneventful pull with a passing notice, and otherwise opens an outcome dialog listing fetches and per-stack results, with **Resolve in <branch>** opening the affected column for inline resolution.
