# Build verified Branch Graphs in the Git module

Build each Branch Graph through one cancellable `@laneway/git` operation invoked in-process by Electron main. The operation owns Git parsing, Base Branch inference, involvement, and verification of pinned refs and worktree heads; the renderer receives immutable typed graph data and never derives topology. Expanded commit histories load lazily against pinned Base and tip object IDs, graph data remains memory-only, and no Engine command is added because this is presentation evidence rather than a scriptable Laneway action.

Subsequent reads update cached ancestry, author evidence, and unchanged branch relationships incrementally, as specified in [ADR 0016](0016-update-branch-graphs-incrementally.md). Ref and context verification remains mandatory before publishing new cache state.

Subsequent reads update cached ancestry, author evidence, and unchanged branch relationships incrementally, as specified in [ADR 0016](0016-update-branch-graphs-incrementally.md). Ref and context verification remains mandatory before publishing new cache state.
