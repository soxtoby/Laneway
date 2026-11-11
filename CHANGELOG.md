# Changelog

## Unreleased

### Added

- Create a tag at a branch's tip or at any commit, from its menu in the Branch Graph or a column. The tag is created on the Branch Graph's remote too, and gets a message if you give it one.
- Tagged commits in a column show a tag icon; hover it to see the tags' names.
- MDX files can switch to the rendered Markdown view, like other Markdown files.

### Changed

- When a branch's column closes because the branch no longer exists, the notice names the branch.
- The Staged divider in Working Changes has an arrow pointing up at the staged files above it.
- Clicking a file in a column selects it, instead of opening its diff underneath it; Ctrl+click still adds files to the selection. Double-click a file, press Enter on it, or use the button that appears when you hover it to open the diff column beside the column. While the diff column is open, clicking a file also scrolls to it.
- A column can only be maximized while its diff column is open, and closing the diff column restores the column's width.
- Clicking a file in a branch comparison column opens the diff column, as double-clicking it does elsewhere.
- Clicking a file in a commit diff column opens the commit's diff in a diff column beside it, scrolled to that file, instead of showing the file's diff under its row.
- A commit diff column opens as wide as a branch column.
- A diff column that opens scrolls into view beside the column it came from. If the two don't fit side by side, the column it came from stays in view.

### Fixed

- Opening the diff of a file that was renamed without changes no longer leaves a blank window.
- Pull latest no longer stays highlighted after a pull restacks a branch onto its Base. The commits the restack replaced on the remote branch aren't new; the branch is ready to publish instead.
- Publish works out what it would push much faster in repositories with many branches, and the Branch Graph loads faster there too, after a commit conflict.
- A conflicted commit's file actions stay in view when its column is narrowed, instead of being cut off at the column's edge.
- The Branch Graph now shows a merged branch joining the Primary Branch even when another branch is stacked on top of it.
- Rewording a commit, rebasing a branch, moving changes between commits, and applying a Historical Edit no longer fail when a commit hook needs installed tools such as `node_modules`. Commit hooks no longer run on each rewritten commit. Instead, the pre-commit hook checks the result afterwards in each worktree whose files changed. If it fails, the notice stays open with the hook's output, and Undo reverses the change.

## v0.1.0-alpha.1

The first alpha release.
