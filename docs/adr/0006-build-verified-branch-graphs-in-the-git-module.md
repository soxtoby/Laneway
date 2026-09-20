# Build verified Branch Graphs in the Git module

Build each Branch Graph through one cancellable `@laneway/git` operation invoked in-process by Electron main. The operation owns Git parsing, Base Branch inference, involvement, and verification of pinned refs and worktree heads; the renderer receives immutable typed graph data and never derives topology. Expanded commit histories load lazily against pinned Base and tip object IDs, graph data remains memory-only, and no Engine command is added because this is presentation evidence rather than a scriptable Laneway action.
