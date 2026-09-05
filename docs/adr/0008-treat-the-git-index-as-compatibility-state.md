# Treat the Git index as compatibility state

Workbench reads and preserves the real Git index so staging performed by Git or another client remains truthful, but does not use staging as its commit-composition model. Workbench composition owns file, hunk, line, and fragment transfers directly because the index has only one destination, cannot express arbitrary commit targets, and would mingle Workbench operations with the user's existing staged state.
