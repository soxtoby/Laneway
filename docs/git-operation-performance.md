# Transfer planning and recovery storage

The minute-long BI stall was an ignored-file collision scan: 111,112 ignored files were each compared against 32,415 destination paths, up to 3.6 billion pairs. The original predicate took 480.9 seconds on BI's real path lists. The replacement indexes paths and directory ancestors once and took 57–101 ms for the same comparison. Git first summarizes ignored directories (185 entries in about 160 ms); only a possible collision requires enumerating their files. Adding an unrelated sibling inside an ignored directory remains allowed, while exact paths and both file/directory collision directions remain protected.

Transfers previously rebuilt the complete composition plan during execution and created an isolated checkout for each rewritten commit, even when there were no commit hooks. Snapshot collection also repeated working-tree construction and performed two serial filesystem stats per file. Recovery retained each snapshot's refs plus duplicate before/after ref-change entries, adding visible decorations and directories visited by Git-lock checks.

The Engine now persists one disposable, versioned, integrity-checked composition preview per repository. Execution recaptures Git/file/index/config state, compares the exact request and remote refs, rechecks Git-operation markers and ignored-file collisions, and only then reuses the plan. Missing, damaged, or pruned preview objects cause replanning. Hooks still run in isolated checkouts; commits without hooks use `commit-tree` directly with the existing author, cleanup, and signing behavior. Working trees are prepared once per plan, clean trees reuse the index tree, immutable commit trees are read with topology, and filesystem metadata is read in bounded batches.

The same-worktree transfer repro also exposed a correctness defect: applying incoming changes before restoring a rewritten HEAD could delete the selected addition from both commit and disk. Incoming changes are now applied to the restored destination.

Recovery uses the protected object pool in [ADR 0014](adr/0014-retain-operation-objects-in-protected-packs.md). Repeated retention and undo/redo share objects instead of creating additional refs. Legacy refs migrate under the existing mutation lock. Initial migration and pack consolidation can still take time in large repositories; multi-commit replay, configured hooks, signing, and full snapshot validation also remain real costs.

BI validation found 32,415 tracked files, 72 existing packs, and 698 legacy recovery refs. In a disposable local clone without BI's ignored build/dependency files, preview fell from 29.4 seconds to 9.5 seconds after migration; the subsequent apply took 24.3 seconds. The first optimized preview took 30.0 seconds including migration of all 698 refs. Existing packs are excluded from the consolidation threshold, avoiding a full-history repack in repositories that already have many packs. Clone measurements used LFS pointers with downloads disabled; the user's checkout was only read. File hashing still dominates the steady-state preview, so this does not establish sub-second transfers. Reading and validating the original 106 MB of operation logs took about 0.5 seconds, and graph/topology reads were below two seconds.

Regression coverage:

- Moving a committed file into its own Working Changes, then undo/redo after Git pruning.
- BI-scale path comparison; exact, ancestor, descendant, and sibling collisions; ignored-directory siblings remain untouched.
- Reusing a verified plan; rebuilding a damaged or pruned plan; rejecting a newly created ignored destination file.
- Reusing existing packs, sharing retention across operations, migrating duplicate refs, and releasing abandoned state, in SHA-1 and SHA-256 repositories.
- Existing hook/filter/signing, stale-state, conflict, linked-worktree, crash-recovery, and production Electron IPC tests.
