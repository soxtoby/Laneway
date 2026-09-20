# Treat the Git index as compatibility state

Revised for ordinary commits by [ADR 0012](0012-use-git-staging-for-ordinary-commits.md). The rationale below continues to apply to transfers into arbitrary commit destinations.

Laneway reads and preserves the real Git index so staging performed by Git or another client remains truthful, but does not use staging as its commit-composition model. Laneway composition owns file, hunk, line, and fragment transfers directly because the index has only one destination, cannot express arbitrary commit targets, and would mingle Laneway operations with the user's existing staged state.
