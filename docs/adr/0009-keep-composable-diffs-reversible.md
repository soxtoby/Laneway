# Keep composable diffs reversible

Workbench uses diff representations that map back to exact Git and worktree content, and disables external diff programs and `textconv` in its primary diff views. Custom converted output can improve inspection but cannot reliably identify changes that Workbench can transfer into another commit; V1 therefore summarizes those files and leaves any future configured-diff view read-only.
