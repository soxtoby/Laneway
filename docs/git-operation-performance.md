# Transfer planning and recovery storage

The minute-long BI stall was an ignored-file collision scan: 111,112 ignored files were each compared against 32,415 destination paths, up to 3.6 billion pairs, taking 480.9 seconds on BI's real path lists. Transfers were given an indexed replacement, but the conflict-acceptance path kept the original predicate and stalled the same way until October 2026. The scan is now gone from both paths under [ADR 0022](adr/0022-treat-ignored-files-as-git-does.md): a rewritten tree is written over an ignored file in its way, exactly as `git checkout` does, and no operation pays for a listing of ignored paths to guard them.

Transfers previously rebuilt the complete composition plan during execution and created an isolated checkout for each rewritten commit, even when there were no commit hooks. Snapshot collection also repeated working-tree construction and performed two serial filesystem stats per file. Recovery retained each snapshot's refs plus duplicate before/after ref-change entries, adding visible decorations and directories visited by Git-lock checks.

The Engine now persists one disposable, versioned, integrity-checked composition preview per repository. Execution recaptures Git/file/index/config state, compares the exact request and remote refs, rechecks Git-operation markers, and only then reuses the plan. Missing, damaged, or pruned preview objects cause replanning. Hooks still run in isolated checkouts; commits without hooks use `commit-tree` directly with the existing author, cleanup, and signing behavior. Working trees are prepared once per plan, clean trees reuse the index tree, immutable commit trees are read with topology, and filesystem metadata is read in bounded batches.

The same-worktree transfer repro also exposed a correctness defect: applying incoming changes before restoring a rewritten HEAD could delete the selected addition from both commit and disk. Incoming changes are now applied to the restored destination.

Recovery uses the protected object pool in [ADR 0014](adr/0014-retain-operation-objects-in-protected-packs.md). Repeated retention and undo/redo share objects instead of creating additional refs. Legacy refs migrate under the existing mutation lock. Initial migration and pack consolidation can still take time in large repositories; multi-commit replay, configured hooks, signing, and full snapshot validation also remain real costs.

BI validation found 32,415 tracked files, 72 existing packs, and 698 legacy recovery refs. In a disposable local clone without BI's ignored build/dependency files, preview fell from 29.4 seconds to 9.5 seconds after migration; the subsequent apply took 24.3 seconds. The first optimized preview took 30.0 seconds including migration of all 698 refs. Existing packs are excluded from the consolidation threshold, avoiding a full-history repack in repositories that already have many packs. Clone measurements used LFS pointers with downloads disabled; the user's checkout was only read. File hashing still dominates the steady-state preview, so this does not establish sub-second transfers. Reading and validating the original 106 MB of operation logs took about 0.5 seconds, and graph/topology reads were below two seconds.

Regression coverage:

- Moving a committed file into its own Working Changes, then undo/redo after Git pruning.
- BI-scale path comparison; exact, ancestor, descendant, and sibling collisions; ignored-directory siblings remain untouched.
- Reusing a verified plan; rebuilding a damaged or pruned plan; rejecting a newly created ignored destination file.
- Reusing existing packs, sharing retention across operations, migrating duplicate refs, and releasing abandoned state, in SHA-1 and SHA-256 repositories.
- Existing hook/filter/signing, stale-state, conflict, linked-worktree, crash-recovery, and production Electron IPC tests.

## Exact BI file extraction

The follow-up reproduction moves `build/BITypeScriptGenerator.cs` from `ca02a6367c7d56d446f15be3c317916056143f06` into Working Changes. Its source changes 27 files; three later commits do not touch the selected path. The chain belongs only to `sox/type-faster`. The focused path in [ADR 0015](adr/0015-scope-independent-file-extraction.md) rewrites its four commits in one `fast-import`, updates the branch with an expected-old-value transaction, and changes the selected index entry. Working file bytes stay unchanged.

The original general planner reads whole worktree snapshots, prepares trees with temporary indexes and `merge-tree`, constructs commits with repeated `commit-tree` invocations, restores checkout state, and rebuilds the graph. The focused path still performs repository/configuration/ref checks, source inventory validation, three scoped snapshots (prepare, pre-mutation validation, and after), recovery packing, and graph/Working Changes refresh. Each snapshot retains the complete index and administrative state. It does not need whole-tree file hashing, merging, checkout, or per-commit process launches.

A trace after introducing focused extraction but before consolidating preview/apply contained 80 Git process starts: 22 preview, 40 apply, and 18 refresh. The consolidated path has 38 transfer starts plus 18 refresh starts (56 total), including one internal `unpack-objects`. Automatic CLI discovery includes two version probes; the desktop's explicit cached native Git executable needs one. Trace logging is excluded from timing measurements.

Recorded matching BI clones with 32,415 tracked files, 152 graph branches, a 130 MB completed journal, and 74 MB Operation History:

| Phase | `d6b41d2` | Focused, consolidated transfer |
| --- | ---: | ---: |
| Preparation and application | 35.66 s (two calls) | 3.53 s (one call) |
| Graph, Working Changes, and independent verification | 4.65 s | 1.68 s |
| Click through refreshed result | 40.32 s | 5.22 s |

The updated recording also verifies undo/redo, unchanged working bytes, and zero recovery refs. It uses the production transfer controller, compiled engine, and Git readers in an Electron evidence harness with HTTP replacing IPC; this is not a full-desktop latency measurement. Both clones have LFS smudging disabled, matching line endings, and fixture-only invalid remotes. Ignored outputs and missing linked worktrees were not copied. Existing protected recovery packs were copied, so initial pool creation is outside these measurements. The first updated transfer builds its journal checkpoint.

The full subsecond target remains unmet. The graph alone measured 1.37 seconds in the updated recording; large historical operation snapshots, durable storage, and remaining Git process launches also contribute. The complete journal remains intact: checksum checkpoints skip repeated parsing of verified finalized records. Redo abandonment releases membership without immediate pack consolidation; unused objects remain protected until the existing consolidation threshold or the pool becomes empty.

The standalone explanation and embedded videos are in `.tmp/performance/exact-report.html`; raw measurements are `.tmp/performance/exact-transfer/video-before.json` and `video-after.json`. These are local ignored evidence artifacts.

## Incremental graph refresh

[ADR 0016](adr/0016-update-branch-graphs-incrementally.md) adds session-local caches for commit ancestry, author matching, unchanged branch relationships, and eight recent display results. New roots read only previously unseen history. Simple unshared branch-end rewrites reuse Base Branch inference; structural changes recalculate it using the cached ancestry. Undo/redo can reuse the prior display result after checking current refs, worktrees, configuration, and mailmap inputs.

The same BI transfer benchmark, measured without trace logging:

| Graph read | Before incremental caching | After |
| --- | ---: | ---: |
| First read | 1,183 ms | 1,162 ms |
| Unchanged | 138 ms | 140 ms |
| After transfer | 1,215 ms | 524 ms |
| After undo | 1,243 ms | 144 ms |
| After redo | 1,269 ms | 140 ms |

Independent cold reads matched incremental graph facts through the exact transfer, undo, and redo. A separate fresh-fixture recording measured 492 ms for graph refresh and 4.55 seconds for the complete transfer including Working Changes and verification. That recording's engine phase was 3.74 seconds; the full subsecond target remains unmet. Original BI stays read-only.

The new explanation and recording are `.tmp/performance/incremental-report.html` and `exact-incremental.mp4`; benchmark data is in `graph-cache-before.json` and `graph-cache-final.json`. Earlier reports retain their original measurements.

## Reword

Rewording the second-to-last commit of a three-commit fixture took 5 to 7 seconds through the compiled engine. The cost was Git process launches, about 40 ms each on Windows, in a mostly sequential chain: the desktop invoked the engine twice (preview, then apply), each invocation captured the repository checkpoint over every registered worktree, and the apply re-prepared before reusing the persisted plan. One reword started 96 Git processes across the two invocations, and each extra linked worktree added about 50 more because a capture walks every worktree and ran five times. An ignored dependency tree made no measurable difference.

Changes:

- `local-transfer` accepts rewords and applies an uncontentious one in the same invocation. Published history, removed commits, and conflicts still return a preview that a confirmed `local` call applies. The immediate path skips the preparation's own checkpoint verification, because mutation re-verifies before changing refs.
- Composed commits share one per-operation read of configuration, hooks, signing, and cleanup settings instead of re-reading them for every commit, and raw commit objects are read once per process.
- Replay skips `merge-tree` when the new parent's tree equals the old parent's, which is every descendant of a reword, and worktree restoration skips it when the moved HEAD has the same tree. Draft commits remember their trees. A step's conflict-source draft is created only when an unresolved stack records the step. Checkouts are skipped for worktrees whose files and index are unchanged.

Measured with `.tmp/diagnose/reword-bench.ts` on a fresh fixture with the compiled engine: Git launches per reword fell from 96 across two invocations to 56 in one, and wall time from 5–7 s to about 2 s, interleaved on the same machine while it was otherwise loaded. With three extra linked worktrees: 6.1 s to 4.1 s. The remaining cost is three checkpoint captures per call (preparation, pre-mutation verification, and the post-mutation expected state), the graph read, and about twenty sequential planning launches.

## Repeated reads within an operation

A trace of every Git launch across a reword, undo, redo, composition, worktree creation, and conflict acceptance on a fixture with two linked worktrees showed the same read commands launched again with nothing changed in between. The pre-mutation checkpoint verification repeats the preparation capture exactly when only object writes separate them, and an undo captures the departing state right after verifying it. Each capture costs four repository reads plus three to six per registered worktree.

While the Engine holds the mutation lock, `RepositoryGit` memoizes read commands: a repeated read with the same directory, arguments, and input returns the first result. Any command that may change refs, configuration, the index, worktrees, or registrations drops the memo, as does any run with a custom environment, and code that writes worktree files or index files directly calls `forgetReads`. Failures are never kept, since another process's lock can cause one. The desktop's long-lived instances never enable the memo, because other processes change the repository under them.

Measured with `.tmp/diagnose/git-repeats.ts`, in-process, two linked worktrees, launches per operation:

| Operation | Before | After |
| --- | ---: | ---: |
| Reword (one call) | 84 | 68 |
| Undo | 83 | 54 |
| Redo | 82 | 53 |
| Composition preview | 73 | 56 |
| Composition apply | 67 | 53 |
| Worktree creation | 22 | 21 |
| Conflict rewrite | 107 | 100 |
| Conflict choose | 34 | 32 |
| Conflict acceptance | 119 | 109 |
| History | 21 | 21 |

Conflict operations gain least because their captures are separated by real changes, and the rest of their launches build trees. Within one process, a file the user edits between the preparation capture and the mutation is no longer caught by the pre-mutation verification; the post-mutation capture records it instead, and the cross-process guard between a preview and its confirmed apply is unchanged.
