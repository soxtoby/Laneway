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
The visual identity of a repository in navigation: a user override, otherwise an inferred project icon, otherwise two initials.
_Avoid_: App icon

**Command Lens**:
The global keyboard-first search and navigation surface. Selecting a branch locates it in the Branch Graph; the Command Lens never switches a worktree itself.
_Avoid_: Command palette, branch switcher

**Workspace Column**:
A resizable view of an Active Stack ending at one branch. It may be branch-only, or worktree-backed with Working Changes; every Registered Worktree retains a column that can be collapsed in place; branch-only columns can be closed. Removing a worktree removes its column. Collapsing preserves column order and expanded width.
_Avoid_: Worktree column

**Workspace State**:
The persisted presentation of repositories and Workspace Columns, including their order, size, collapse state, focus, and each column's unified or side-by-side diff preference. Laneway restores it after restart but does not restore broken-out diffs, focused inspection, selected files, selected changes, or scroll positions; Git facts are always recomputed.
_Avoid_: Repository cache, persisted Git state

**Open Repository**:
A repository retained in Workspace State and shown in the repository rail, whether its Git directory is currently available or missing.
_Avoid_: Session repository

**Worktree Backing**:
Worktree Backing is the association between one filesystem worktree and one Workspace Column. Checking out from a branch-only column transfers it without moving columns; switching a worktree to a branch held elsewhere preserves and detaches the previous worktree, while undo restores both worktrees unless external changes make replay unsafe.
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
An explicit operation that unregisters and deletes a linked worktree after offering to preserve its Working Changes and Worktree-only Commits, recursively stashing populated submodules where needed. Laneway privately retains all affected Git state for undo, while ignored files remain outside undo; preserved stashes remain Branch Markers until explicitly applied, unless undo reapplies them while recreating the worktree.
_Avoid_: Close column, prune worktree

**Worktree Rename**:
An explicit change to a linked worktree directory's basename within its current parent, with its Git registration repaired as one Laneway Operation. Laneway does not relocate worktrees between parent directories, and renaming is unavailable when the worktree contains populated submodules.
_Avoid_: Worktree label

**Laneway Engine**:
The headless CLI executable, named `lane`, that performs coarse-grained, scriptable Laneway actions. The desktop application invokes one process per action; people and agents may invoke the same actions directly, while repository-entry mechanics need not be CLI commands.
_Avoid_: Git service, daemon, utility process

**Branch Graph**:
A graph of visible lines of work whose edges place branches relative to their Base Branches. It shows Involved Branches, the Primary Branch, their Base chains, checked-out branches, detached worktree heads, and required remote Base candidates by default; the user may show other branches, while merged inactive branches remain normally hidden.
_Avoid_: Commit graph

**Graph Selection**:
The one Branch Node, Tag Node, or Virtual Branch highlighted in a repository's Branch Graph. Selecting only highlights the node and exposes its controls; it never opens a Workspace Column, and hiding the node clears the selection.
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
A repository-scoped fetch and local synchronization of every open Active Stack, including incoming changes from each branch's upstream and its Base Branch. Its scope includes intermediate branches without their own columns, excludes branches outside all open stacks, and never includes publication.
_Avoid_: Git pull

**Publish**:
An explicit remote update for the focused Active Stack, excluding its Base Branch and unrelated stacks. Branches without upstream publish to same-named branches on the selected remote; the control identifies every destination and force-with-lease update before activation.
_Avoid_: Push, push stack

**Publish Receipt**:
A durable record of intended and completed remote ref updates for one Publish, including a partial sequential outcome. It enables Resume and lease-guarded restoration; it is not an ordinary undo entry.
_Avoid_: Publish undo, push log

**Laneway Operation**:
An immediate Git mutation recorded in a persistent linear undo/redo history. Undo and redo are transitions through eligible operations, not new operations themselves; a new operation after undo makes the abandoned redo path unavailable. External repository changes may create a boundary beyond which replay is unsafe; files outside Git state, including ignored files, are outside undo.
_Avoid_: Command, action

**Operation History**:
The repository-wide persistent linear record of Laneway Operations around the current undo/redo position, shared across linked worktrees. It is distinct from Git commit history and the recovery journal.
_Avoid_: History, journal, reflog

**Branch Node**:
One line of work combining its local and upstream tips while exposing their divergence; its expanded history contains commits unique to its Base Branch. Pull-request state appears as a marker, while a qualifying remote-only branch forms its own node.
_Avoid_: Local branch node, remote branch node

**Branch Marker**:
Non-structural state attached to a branch in the graph, including pull-request state, ordinary stashes, and kept Historical Working Changes labelled with their historical base. Unassigned stashes are accessed outside the graph.
_Avoid_: Branch node, decoration

**Tag Node**:
A tag occupying its commit's position as a history waypoint when that commit is not a branch head; it is never a Target Branch. A tag on a branch head is shown on that Branch Node.
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
A read-only auxiliary column for inspecting one commit's complete diff against one explicit parent without replacing its source column's selection. A merge commit initially uses its first parent, and the user may select another parent.
_Avoid_: Diff Workspace Column

**Working Changes Diff Column**:
A transient auxiliary column that breaks the selected Working Changes diff out from its source Workspace Column. Closing it or restarting Laneway returns the source column to inline diff.
_Avoid_: Diff Column, Commit Diff Column

**Working Changes**:
The uncommitted, non-ignored changes belonging to one worktree. Before checkout changes, Laneway stores them in an ordinary Git stash associated with the old branch and exposes that stash as a Branch Marker. When Worktree Backing transfers between open columns, the old column keeps them visible as Stashed Working Changes. Ordinary commits use Git's staged snapshot when present, otherwise all Working Changes; transfers to arbitrary destinations use Change Selection.
_Avoid_: Staged changes, unstaged changes

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

**Branch Comparison**:
An ordered live diff from one branch identity to another, recomputed when either tip moves. It follows an explicit Laneway branch rename; an external replacement requires user confirmation. A branch's unique changes are inspected by expanding its commits.
_Avoid_: Three-dot diff

**Branch Comparison Column**:
A read-only source-linked auxiliary column showing a Branch Comparison between two branch identities. Unique commits remain part of the compared branch's Active Stack.
_Avoid_: Comparison Workspace Column, Three-dot Diff Column
