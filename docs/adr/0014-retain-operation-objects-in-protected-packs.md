# Retain Operation History objects in protected Git packs

Supersedes the recovery-ref storage detail in ADR 0011. Operation History, journal phases, expected-state validation, and undo/redo behavior remain unchanged.

Retain snapshots and their reachable Git objects in ordinary Git packs protected by `.keep` files. Store operation-to-object membership and protected pack identities in an integrity-checked manifest under the repository's shared `laneway` directory. The repository mutation lock covers every update. No `refs/laneway/recovery/*` decorations are needed.

Reuse existing repository packs during initial retention rather than copying their history. Pack only newly required objects thereafter, excluding objects already protected by the pool. Consolidate after 32 incremental recovery packs and when releasing an operation; existing baseline packs neither count toward this threshold nor get copied during consolidation. Keep the baseline protected until the pool becomes empty. Write and sync replacement packs and the manifest before releasing old protection; Git garbage collection can reclaim unpinned packs. A crash may leave extra protected objects, never an intentionally unprotected undo entry. Do not remove or depend on another tool's `.keep` file.

Migrate legacy recovery refs by retaining their reachable objects first, durably recording their operation membership, then deleting refs with expected-old-object checks in one Git transaction. Keep conflict metadata and conflict-candidate refs separate; they have different semantics.

Packed storage uses Git's native reachability and object-format handling, including SHA-256. Snapshot file contents, detached HEAD history, index state, and stash state remain available after pruning. Reflog changes and other external state changes can still establish the existing undo boundary.

The tradeoff is a one-time reachability walk for initial retention/migration, plus occasional pool consolidation. Initial reuse can temporarily protect unrelated objects in an existing pack. This avoids visible ref noise and repeated full-history copies; ordinary Git clients still read the same objects without configuration changes.

References: [Git pack objects](https://git-scm.com/docs/git-pack-objects), [Git pack protection](https://git-scm.com/docs/git-index-pack#Documentation/git-index-pack.txt---keep).
