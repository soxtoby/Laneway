# Laneway

Laneway is an opinionated standalone Git client for general developers. Its language centres on understanding and reshaping lines of work.

## Language

**Laneway**:
The product as a whole: a standalone Git client with deliberate workflow opinions. Its desktop application, its Engine, and its data all carry the Laneway name.
_Avoid_: Git GUI, companion tool, Git Workbench, Workbench

**V1**:
The first supported Laneway release: a Windows product covering the settled local workflows and ordinary Git remote synchronization and publication. macOS and mainstream Linux are best-effort; hosted-provider and AI-assisted workflows are later releases.
_Avoid_: MVP, technical preview

**Repository Icon**:
The visual identity of a repository in navigation: a user override, otherwise the repository's one unambiguous favicon, otherwise two initials of its Repository Label. An override is a Tabler icon or monogram in a palette colour, an emoji, or an image file read from where it is. Favicons in one directory are one icon in several formats; favicons in different directories count as one only when identical. The override and label persist in Workspace State.
_Avoid_: App icon, avatar

**Repository Label**:
The name shown for a repository everywhere in Laneway: a user-chosen label, otherwise the folder name of its Main Worktree. Changing it never renames the folder. Both are edited from the repository's context menu in the rail.
_Avoid_: Repository name, title

**Repository Script**:
A one-line command the user saves for a repository, with a name and an icon chosen as a Repository Icon's override is (its name's initials without one), run in a worktree's directory from the script button on that worktree's Workspace Column. It runs through the system shell with no window, reporting only a failure, with the end of its output, or, if chosen, in a terminal window that stays open. The button repeats the repository's last-run script. Its menu lists opening the worktree in the platform's file manager, which every repository has and which can't be changed or removed, then each script with a gear that configures or deletes it, then creating one. Deleting applies at once with Undo. Scripts and the last-run choice persist in Workspace State.
_Avoid_: Custom command, action, task

**Command Lens**:
The global keyboard-first search and navigation surface. Selecting a branch locates it in the Branch Graph; the Command Lens never switches a worktree itself.
_Avoid_: Command palette, branch switcher

**Workspace Column**:
A resizable view of an Active Stack ending at one branch, or a Branch Comparison Column. A stack column may be branch-only, or worktree-backed with Working Changes; every Registered Worktree retains a column that can be collapsed in place; branch-only and comparison columns can be closed. Removing a worktree removes its column. Collapsing preserves column order and expanded width.
_Avoid_: Worktree column

**Workspace State**:
The persisted presentation of repositories and Workspace Columns, including their order, size, collapse state, focus, and each column's unified or side-by-side diff preference. Laneway restores it after restart but does not restore broken-out diffs, focused inspection, selected files, selected changes, or scroll positions; Git facts are always recomputed.
_Avoid_: Repository cache, persisted Git state

**Open Repository**:
A repository retained in Workspace State and shown in the repository rail, whether its Git directory is currently available or missing.
_Avoid_: Session repository

**Worktree Backing**:
Worktree Backing is the association between one filesystem worktree and one Workspace Column. Checking out from a branch-only column transfers it without moving columns; switching a worktree to a branch held elsewhere preserves and detaches the previous worktree, while undo restores both worktrees unless external changes make replay unsafe. A remote-only branch checks out as a new local branch of the same name tracking it, and its column becomes that branch's; when a local branch has the name already, the user chooses between resetting that branch to the remote branch and tracking it, or creating the name with the next free counter, such as `feature-2`.
_Avoid_: Switch column, replace column

**Main Worktree**:
Git's permanent repository worktree, unrelated to the Primary Branch. It may change branches, but Laneway never moves, removes, or cleans it; if its path disappears, the repository remains unavailable until the user locates it.
_Avoid_: Primary Worktree

**Worktree Home**:
The parent directory for newly created linked worktrees: a `<repository>.worktrees` sibling of the Main Worktree, with initial directory names derived from their branches. Configurable placement is deferred.
_Avoid_: Worktree storage

**Registered Worktree**:
Any Main or linked worktree recorded by Git, regardless of which tool created it. Laneway discovers and surfaces every Registered Worktree automatically.
_Avoid_: Managed worktree, external worktree

**Locked Worktree**:
A linked worktree protected by a Git worktree lock and its optional reason. Laneway blocks rename and removal until the user explicitly unlocks it.
_Avoid_: Read-only worktree

**Missing Worktree**:
A registered linked worktree whose directory is unavailable at its recorded path while its per-worktree HEAD and index remain in Git's shared administrative data. The user may locate and repair it or explicitly remove its registration; Laneway never prunes it automatically, and external Git pruning creates an undo boundary.
_Avoid_: Deleted worktree, stale worktree

**Worktree Removal**:
An explicit operation that unregisters and deletes a linked worktree, preserving its Working Changes and Worktree-only Commits and recursively stashing populated submodules where needed. Only a worktree with Working Changes asks first, and there the user may let both go. Laneway privately retains all affected Git state for undo, while ignored files remain outside undo; preserved stashes remain Branch Markers until explicitly applied, unless undo reapplies them while recreating the worktree.
_Avoid_: Close column, prune worktree

**Worktree Rename**:
An explicit change to a linked worktree directory's basename within its current parent, with its Git registration repaired as one Laneway Operation. Laneway does not relocate worktrees between parent directories, and renaming is unavailable when the worktree contains populated submodules.
_Avoid_: Worktree label

**Laneway Engine**:
The headless CLI executable, named `lane`, that performs coarse-grained, scriptable Laneway actions. The desktop application invokes one process per action; people and agents may invoke the same actions directly, while repository-entry mechanics need not be CLI commands.
The public CLI uses ordinary arguments and help. Basic Git commands preserve Git behavior while participating in Laneway undo; the desktop also retains its snapshot-based request transport. See [the command reference](docs/cli.md).
_Avoid_: Git service, daemon, utility process

**Branch Graph**:
A graph of visible lines of work whose edges place branches relative to their Base Branches. It shows local branches, Involved Branches, the Primary Branch, remote branches matching the repository's remote patterns, their Base chains, and detached worktree heads by default; the user may show every branch instead. The Engine decides which branches form the graph; the renderer only collapses Base chains.
_Avoid_: Commit graph

**Graph Selection**:
The one Branch Node, Tag Node, or Virtual Branch highlighted in a repository's Branch Graph. Selecting only highlights the node and exposes its controls; it never opens a Workspace Column, and hiding the node clears the selection. Double-clicking a branch, or Enter, checks it out in the Main Worktree at once, with Undo; a branch already checked out, only on a remote, or that the Main Worktree can't take opens its column instead. Its menu's Check out does the same where it can check out, and the chevron beside it, Check out in, chooses any worktree or a new one.
_Avoid_: Open branch, active branch

**Open Branch**:
A branch represented by a Workspace Column. Opening creates or focuses its column independently of Graph Selection and Branch Graph filtering.
_Avoid_: Selected branch

**Author Identity**:
An email address Laneway treats as belonging to the current developer after repository mailmap canonicalization. One application-wide primary address and any number of secondary addresses determine branch involvement.
_Avoid_: User account, Git identity

**Involved Branch**:
A branch whose unique history contains a commit authored by any Author Identity. Involved Branches appear by default; other branches remain available on request.
_Avoid_: My branch, owned branch

**Base Branch**:
The closest branch, inferred from repository topology, whose reachable history excludes the current branch's unique commits. Its difference from the current branch defines the commits shown for that branch and the base offered for stack synchronization. Equivalent refs at the same effective base are presentation aliases, not ambiguity.
_Avoid_: Target branch, parent branch, integration branch

**Primary Branch**:
The repository's main line of development, inferred from the selected remote's default branch. It anchors the Branch Graph and breaks otherwise-equal Base Branch topology ties, but never supersedes a topologically closer base.
_Avoid_: Main branch, master branch, default branch

**Active Stack**:
The ordered branch chain from an integration target through the branch shown in a Workspace Column. A worktree-backed column ends at that worktree's checked-out branch.
_Avoid_: Active branch

**Pull latest**:
A fetch and local synchronization of a Workspace Column's Active Stack, together with every open Active Stack sharing a branch above its Base with it, including incoming changes from each branch's upstream and its Base Branch. Its scope includes intermediate branches without their own columns, excludes branches outside those stacks, and never includes publication. Background fetching fast-forwards branches outside every open stack instead.
_Avoid_: Git pull

**Publish**:
An explicit remote update for a branch's Active Stack, up to and including that branch, excluding its Base Branch and unrelated stacks. Branches without upstream publish to same-named branches on the selected remote; the control identifies every destination and force-with-lease update before activation. The Primary Branch, having no Base Branch, publishes alone; the desktop asks first, warning when it would force.
_Avoid_: Push, push stack

**Move into Base**:
A Laneway Operation that moves a branch's local Base Branch up to the branch's tip, so the base holds the branch's own commits unchanged and the branch has none left of its own. It is offered only while the base's tip is still in the branch's history; a base that moved on needs the branch rebased onto it first. A worktree with the base checked out has its files brought along, keeping its Working Changes as a checkout does, and Git refuses as it would if they'd be overwritten. The branch stays, and nothing is published. It runs at once, with Undo.
_Avoid_: Merge, land, integrate, fast-forward

**Publish Receipt**:
A durable record of intended and completed remote ref updates for one Publish, including a partial sequential outcome. It enables Resume and lease-guarded restoration; it is not an ordinary undo entry.
_Avoid_: Publish undo, push log

**Laneway Operation**:
An immediate Git mutation recorded in a persistent linear undo/redo history. Undo and redo are transitions through eligible operations, not new operations themselves; a new operation after undo makes the abandoned redo path unavailable. Each operation records the changes it made, and undo applies their inverse to the repository as it is now rather than returning it to a point in time: Working Changes made since stay in place, stashed and reapplied only where the reversal touches their files, and a branch moved outside Laneway makes that operation's undo unavailable while nothing else is checked ([ADR 0023](docs/adr/0023-undo-reverses-recorded-changes.md)). An interrupted operation is completed or reversed by the next Engine run; unusual failures may require manual recovery. Native Git wrappers record their inverses after Git finishes, without a repository lock around Git execution. Commit undo moves only the recorded ref; staging undo restores the index. Ignored files are outside workflow undo, but native stash undo includes them when explicitly stashed with `--all`.
_Avoid_: Command, action

**Working Changes Discard**:
An immediate removal of chosen Working Changes from a worktree: whole files from a file row's context menu, or selected lines from an unstaged diff. It is not a Laneway Operation and never enters the Operation History. The originals move aside by rename within the worktree's git directory, so a discard costs the same for any file size; a notice offers Undo and Ctrl+Z for a few seconds, further discards join that notice, and when it closes the originals are released for good. A staged discard returns index and worktree to HEAD, and its undo stages the restored files in full; an unstaged discard returns the worktree to the index. A file edited again inside the window is kept rather than overwritten by undo. Ignored files and files in use are untouched.
_Avoid_: Revert, checkout, clean, reset

**Operation History**:
The repository-wide persistent linear record of Laneway Operations around the current undo/redo position, shared across linked worktrees. It is distinct from Git commit history and the recovery journal.
_Avoid_: History, journal, reflog

**Branch Node**:
One line of work combining its local and upstream tips while exposing their divergence; its expanded history contains commits unique to its Base Branch. Local branches sharing a tip remain separate Branch Nodes drawn on one commit. Pull-request state appears as a marker, while a qualifying remote-only branch forms its own node.
_Avoid_: Local branch node, remote branch node

**Branch Marker**:
Non-structural state attached to a branch in the graph, including pull-request state, ordinary stashes, and kept Historical Working Changes labelled with their historical base. Unassigned stashes are accessed outside the graph.
_Avoid_: Branch node, decoration

**Tag Node**:
A tag occupying its commit's position as a history waypoint when that commit is not a branch head; it is never a Target Branch. A tag on a branch head is shown on that Branch Node. Creating a tag, at a Branch Node's tip or at a commit from its menu, makes it locally and on the Branch Graph's remote together, annotated when it has a message; a tag the remote refuses isn't kept locally either. Undo removes only the local tag.
_Avoid_: Tag branch

**Virtual Branch**:
A changes-only view of a Registered Worktree's clean or dirty detached head, created by branch relocation or deletion of its checked-out branch, with an editable default branch name. Its column remains available with commit history hidden until attached; committing first creates the real branch, while switching away from unique state creates a protective branch and stashes any Working Changes.
_Avoid_: Detached HEAD

**Worktree-only Commit**:
A commit reachable from a detached worktree's HEAD but from no branch or tag. Removing that worktree can leave the commit unreachable, so preserving removal first creates a branch for it.
_Avoid_: Detached commit, orphan commit

**History Trail**:
A file-focused investigation expressed as an evidence-linked tree of File History Columns and Commit Diff Columns. It follows mutable source identities, preserves immutable commit sources, and may branch through another file changed by a candidate commit without claiming Git stores canonical cross-file provenance.
_Avoid_: File log

**File History Column**:
A source-linked auxiliary column anchored to one file and either a mutable branch or worktree identity or an immutable commit. Mutable sources update with repository state; only a worktree source includes its current Working Changes. It exposes the commits that changed the file and may continue a History Trail through evidence-linked files.
_Avoid_: File log column, History Workspace Column

**Commit Diff Column**:
A read-only auxiliary column for inspecting one commit's complete diff against one explicit parent without replacing its source column's selection. A merge commit initially uses its first parent, and the user may select another parent. Pressing one of its files opens the commit's whole diff in a diff column beside it, scrolled to that file; while that is open, pressing another file scrolls to it. Choosing another parent closes it.
_Avoid_: Diff Workspace Column

**Working Changes Diff Column**:
A transient auxiliary column showing a worktree's whole Working Changes diff beside its source Workspace Column, scrolled to the chosen file; a Workspace Column shows diffs nowhere else. A double-click or Enter on a file's row, or the row's button, opens it, and in a read-only Branch Comparison Column so does pressing the row; while it is open, pressing another file scrolls to it instead of replacing the column. It scrolls into view as it opens, keeping its source column in view. Restarting Laneway closes it.
_Avoid_: Diff Column, Commit Diff Column

**Image Diff**:
The picture view of a changed raster image inside any file diff, in place of text lines. An added or removed image shows that one picture; a changed image compares both versions side by side, with a swipe divider, as an onion-skin fade, or as a difference blend, and the chosen mode persists for the session. Git LFS pointers show the image, downloading the object through Git LFS when the local store lacks it. SVG keeps its text diff.
_Avoid_: Binary diff, image preview

**Rendered Markdown Diff**:
The view of a Markdown file's diff as the documents it renders, which its row may choose over source lines for every Markdown diff in the session. Aligned blocks show deleted and inserted words, formatting that alone changed, and changed code lines, unified or side by side; unchanged blocks away from changes fold unless whole files show, and an added or deleted document renders as it is ([ADR 0028](docs/adr/0028-diff-rendered-markdown-with-an-extractable-engine.md)).
_Avoid_: Markdown preview, rich diff, prose diff

**Working Changes**:
The uncommitted, non-ignored changes belonging to one worktree. Before checkout changes, Laneway stores them in an ordinary Git stash associated with the old branch and exposes that stash as a Branch Marker. When Worktree Backing transfers between open columns, the old column keeps them visible as Stashed Working Changes. Ordinary commits use Git's staged snapshot when present, otherwise all Working Changes; transfers to arbitrary destinations use Change Selection. Amending, from the Commit button's menu, takes the same snapshot into the branch's last commit as Git's amend does: the form fills from that commit's message, the commit keeps its parents and author, and branches built on it stay where they are.
_Avoid_: Staged changes, unstaged changes

**Ignored Files**:
Files Git excludes through its ignore rules, which Laneway treats exactly as Git does: expendable. They are never Working Changes, stay outside undo, and may be overwritten or deleted by any Laneway Operation that touches their path or worktree without a listing, a warning, or a confirmation ([ADR 0022](docs/adr/0022-treat-ignored-files-as-git-does.md)).
_Avoid_: Precious files, local files, excluded files

**Change Selection**:
A selection of files, hunks, or complete lines from exact Working Changes or committed content for a later Laneway Operation. Within-file selection belongs to one visible file diff, never automatically includes paired lines, and becomes invalid when its source content changes; partial-line fragments and text derived by a custom diff program are not selectable.
_Avoid_: Staging, highlighted text

**Historical Edit**:
An explicit temporary mode of a worktree-backed Workspace Column for editing from the snapshot of one commit unique to its focused Active Stack. The original column preserves its prior Working Changes and checks out the selected commit detached; normal commit-composition operations can move new Historical Working Changes to eligible commits, branches, or new-commit seams without ending the session. A clean session offers to return to the original branch; a dirty return offers to drop or bring the remaining Historical Working Changes, or cancel the return. A branch-only column must gain existing Worktree Backing before Historical Edit is available.
_Avoid_: Virtual Branch, conflict-resolution checkout, rebase editor

**Historical Working Changes**:
Working Changes created from the detached snapshot in a Historical Edit. They stay with that historical context until commit composition moves them, the user drops them, or Return to Branch brings them onto the original branch. If that restoration conflicts and the user keeps them stashed, they become a branch-associated Branch Marker labelled with their historical base.
_Avoid_: Replacement commit, original Working Changes

**Working Changes Conflict**:
A deferred conflict produced when Stashed Working Changes cannot be restored cleanly onto a committed tree. Its accepted resolution becomes Working Changes rather than a commit and never restacks descendants.
_Avoid_: Conflicted Commit, Unresolved Stack, stash pop failure

**Unresolved Stack**:
The locally usable provisional result of a completed stack rewrite containing one or more Conflicted Commits. It may continue evolving, but affected and dependent stacks cannot Publish until every deferred conflict is resolved.
_Avoid_: Successful rebase, failed rebase

**Conflicted Commit**:
A commit in an Unresolved Stack that contains deferred content decisions. Accepting its complete resolution rewrites that commit and restacks its descendants.
_Avoid_: Failed commit, paused rebase

**Conflict Resolution**:
Inline resolution within a Workspace Column. Conflicted files in a commit expand Pierre's merge controls in place of the normal diff, with whole-file choices and external merge-tool actions on their file rows. Other files retain their normal diffs. Choices save durable progress; resolved files show a normal diff. Accept resolution belongs to the commit and updates the stack only after every conflict is resolved. Working Changes conflicts also resolve inside the branch column.
_Avoid_: Conflict modal

**Provider Overlay**:
Optional hosted metadata and actions attached to local Git evidence. It refreshes explicitly and by polling, exposes cache freshness, and may be unavailable or unauthenticated without preventing local Laneway use.
_Avoid_: Hosted source of truth

**Provider Repository**:
A repository identity on one hosted provider, connected to a local repository without replacing its Git remotes or refs.
_Avoid_: Remote repository

**Review**:
A provider-hosted review of proposed changes, represented independently from the local branches and immutable patchset commits it references.
_Avoid_: Pull-request branch

**Review Comment**:
A provider-hosted discussion item attached to a Review and its original diff context; it becomes outdated rather than silently moving when the patchset changes.
_Avoid_: Code comment

**Ticket Link**:
A ticket association discovered from a stable textual reference or provider-native relationship, connecting the ticket to repository context without making it part of Git history.
_Avoid_: Commit metadata

**Agent Handoff**:
The fire-and-forget transfer of one Review Comment and its immutable Review/diff context to the configured external agent app. Laneway neither tracks nor controls the result; when direct launch is unavailable it copies an inspectable prompt.
_Avoid_: AI Run, tracked agent task

**Copy Reference**:
A portable textual reference to selected repository or provider context, using immutable Git identities and stable provider URLs where available. Copying creates no session and hands nothing off.
_Avoid_: Agent Handoff

**AI Provider**:
The single application-wide prompt-and-response integration used for every in-product AI-assisted action.
_Avoid_: Per-action agent

**AI Run**:
The Laneway-orchestrated execution record for a long-running in-product AI-assisted action. It retains progress, logs, and resumable Laneway state while Laneway presents bounded problems and applicable repository instructions to the AI Provider, owns all Git operations, and enforces the action's fixed mutation boundary.
_Avoid_: Agent Workspace, AI chat

**Reshape Stack with AI**:
An AI-assisted Laneway Operation that may split, squash, reorder, and reword commits in the focused Active Stack while preserving its final tree and branch membership. It reorganizes existing changes but does not author source changes. Laneway owns replay and feeds resulting Git conflicts through the same AI Run; unresolved failures remain an Unresolved Stack.
_Avoid_: Restack, AI refactoring

**Comparison Ref**:
One end of a Branch Comparison: a commit, a branch identity that follows its tip, or the merge base of two branch identities. A branch's whole set of changes against its Base Branch runs from the merge base of the two to the branch itself.
_Avoid_: Revision, commit-ish

**Branch Comparison**:
An ordered live diff from one Comparison Ref to another, recomputed when a branch involved in either ref moves. It follows an explicit Laneway branch rename; an external replacement requires user confirmation. A branch's individual changes are inspected by expanding its commits.
_Avoid_: Three-dot diff

**Branch Comparison Column**:
A read-only Workspace Column showing a Branch Comparison. It is filtered, broken out into a diff column, and maximized with it like any Workspace Column, and persists in Workspace State by its refs. Unique commits remain part of the compared branch's Active Stack.
_Avoid_: Comparison auxiliary column, Three-dot Diff Column
