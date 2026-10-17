# Core local operations

Behavior decisions for [SOX-135](https://linear.app/soxtoby/issue/SOX-135/implement-core-commits-branches-and-stash-operations). The revised staging prototype was accepted and implementation authorized on 2026-09-13.

## Settled behavior

- Ordinary commits use staged content when present, otherwise all non-ignored Working Changes. Users choose files through real Git staging while the commit form is open. Hunk selection comes with SOX-140; commit is disabled when there are no content changes.
- Changed source content refreshes the preview and requires another commit attempt. Existing staged content remains authoritative; newly appearing files remain unstaged. With no staged changes, the refreshed action explicitly commits all changes.
- Ordinary tip commits are exposed here. This issue establishes the new-commit seam primitive; SOX-140 owns historical insertion and descendant replay with composition.
- Creating a branch at a chosen commit opens a branch-only Workspace Column. Checkout remains explicit.
- A Laneway branch rename follows local identity through open columns and associated stashes, preserving upstream association without renaming the remote branch.
- Deleting a checked-out branch is allowed and leaves its worktree detached at the same HEAD commit. Unique commits require confirmation. Associated stashes become unassigned; branch-only columns close; a Registered Worktree retains its column as a Virtual Branch. Deleted Git state remains available through undo.
- Apply stash targets an explicitly chosen worktree, including another branch, and initially requires clean Working Changes. Successful restoration consumes the ordinary stash while retaining it privately for undo. Conflicts retain the ordinary stash until resolution or explicit keep.
- Explicit Stash Working Changes stashes all Working Changes with an optional label. Partial stashing belongs with composition.
- Deleting a dirty checked-out branch preserves its Working Changes in place. Confirmation for unique commits counts remaining local branches, remote-tracking branches, and tags as protection, excluding worktree HEADs and private undo refs.
- If a hook changes included content, prompt to cancel or continue, listing only changed files. Users cancel to review content. A failed hook blocks committing; cancellation preserves edits and the draft.
- Virtual Branches immediately show an editable, collision-free default branch name derived from the configured prefix and worktree name, with the worktree name separately visible.
- Committing from a Virtual Branch creates the real branch as its own undoable operation before attempting the commit. The branch remains if committing fails; retry uses that branch. A successful commit is the next undoable operation.
- Require a nonblank commit message. Preserve drafts per worktree across restart; clear only after successful commit or explicit discard.
- Before SOX-136 conflict recovery is available, clean stash application works; a conflicting application preserves the stash and original worktree state and explains the unavailable resolution workflow. Enable the full Working Changes Conflict flow with SOX-136.
- Prototype the commit form and stash controls together before settling their presentation.
- The accepted prototype combines inline files, an expandable inline commit form, and real Git staging separated by a labeled divider. It revises ADR 0008 for ordinary commits; see ADR 0012.
- Commits require at least one selected content change; message-only empty commits are unsupported in this issue.
- Newly initialized repositories use the same composer with an editable initial branch name, defaulting to Git's configured initial branch name.
- In the split staging variant, commit uses the real index when it contains changes; otherwise it includes all non-ignored Working Changes. Opening the composer does not stage files. Edits made after staging remain uncommitted when committing the staged snapshot, with a file appearing in both lists where applicable.
- Keep modified files and their expanded diffs inline. The Working Changes header holds `Commit…` and icon-only stash actions. `Commit…` reveals title and message fields directly below the header with Commit and Cancel buttons. Staged changes appear above unstaged changes, separated by a labeled divider rather than individual headings.
- Show the staged section only when it contains staged changes or the commit form is open. Closing the form hides an empty staged section.
- Opening the form and staging never wait for a fresh preview; the form uses the last preview's token, refreshes it in the background, and the engine rejects a stale token at execution so the files can be reviewed again.
- Working Changes Discard runs outside the engine and the Operation History so the discard itself stays fast: the main process renames the originals into the worktree's git directory, then one `git restore` (or a direct rewrite for selected lines) replaces them. There is no confirmation; a notice offers Undo for eight seconds and Ctrl+Z undoes while it shows. Discards made during that window join the same notice and undo together. Closing the notice releases the originals; an interrupted session's leftovers are swept on a later discard. Undo skips files edited after the discard and reports them. A staged discard's undo stages the restored files in full, so a partially staged file comes back fully staged.
- Discard lives in the file row's context menu only, labelled by what it removes (`Discard changes`, `Discard unstaged changes`, `Discard staged changes`, `Discard all changes` for a staged row whose file also has unstaged edits, `Delete untracked file`), and acts on every checked file when the clicked row is one of them. Line discard appears beside a Change Selection in the unstaged view, or the combined view of a file with nothing staged; it rewrites the worktree file from the index-to-worktree diff after checking every displayed line against the file.
- Show Stage all/Unstage all only while the commit form is open. Individual files stage and unstage by dragging them between the staged and unstaged lists (or by keyboard move: M on a file, then the list and Enter); an empty list shows a drop hint. Existing staged files remain visible when the form is closed.

## Prototype verdict

Accepted: keep ordinary file inspection compact, reveal staging controls with the commit form, and retain staged content as an explicit snapshot. Existing staged files remain visible outside composition; an empty staged section appears only with the form. Cancel closes the form and preserves its draft.

## Throwaway prototype

Run `bun run prototype:commits`, then open <http://127.0.0.1:4315/?variant=A>. A is compact inline, B is an expandable composer, and C is split unstaged/staged. The bottom switcher changes variants without clearing the in-memory scenario. Scenario selection and Reset restore sample changes.

The revised prototype is <http://127.0.0.1:4315/?variant=C>: inline files, a staging divider, and an expandable inline commit form. A/B retain file selection for comparison, using the same form (B initially expanded). Cancel closes the form and retains the draft.

The prototype substitutes the Working Changes section of the actual renderer at build time, using fixture data. Git/index mutations are simulated; restart is a simulation that retains the current draft, not durable storage. Production rendering is unchanged. Scenarios cover existing staging, edits after staging, Virtual Branch naming, first commit, hook changes/failure, external edits, and stash apply/drop.

At the prototype stage, typechecking and an isolated Electron interaction/rendering check passed under the existing CSP. The prototype did not test real repository mutation or durable draft persistence.

## Implementation

The production renderer uses typed IPC to invoke `local-preview` and `local` Engine commands. Mutations require their reviewed snapshot token and participate in the persistent operation journal, including staging, branch configuration, symbolic HEAD, and stash associations. Composition uses `local-transfer`: eligible independent file extraction prepares and applies within one locked invocation; other transfers return a preview for the existing token flow. See [ADR 0015](adr/0015-scope-independent-file-extraction.md). No-op failures do not add undo entries. External changes invalidate the preview or block recovery rather than being silently overwritten.

Commits use system Git for staging, filters, identities, hooks, message cleanup, and signing. The new-commit seam builds a commit from an explicit tree and parent, then updates its branch with an expected-old ref transaction. Hook changes pause before creating that commit; failed hooks preserve their edits for review and undo.

Drafts are stored separately from Git, keyed by repository and registered worktree identity. Cancelling preserves the draft; a successful commit clears it. Stash application is checked in an isolated index and worktree before touching the destination. Hunk staging, historical insertion/replay, and conflict resolution remain assigned to SOX-140/SOX-136.

Workspace columns and Branch Graph rows retain individual local branch identities even where the Git module groups refs at the same tip. The graph stretches the shared commit's node across those rows, and each opens, drags, and accepts drops as its own branch. Creating a branch therefore opens its own branch-only column without transferring the existing checkout. Column headers expose branch actions through their context menu; F2 renames and Delete requests deletion.

The production Electron test launches the rebuilt main/preload/renderer and compiled Engine with an isolated profile and disposable repository. It verifies a draft survives an entire process restart, the inline action creates the expected first Git commit, and a branch created at the same tip can be opened, renamed, and deleted without changing the existing checkout.
