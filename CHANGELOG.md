# Changelog

## Unreleased

### Added

- Create a tag at a branch's tip or at any commit, from its menu in the Branch Graph or a column. The tag is created on the Branch Graph's remote too, and gets a message if you give it one.
- Tagged commits in a column show a tag icon; hover it to see the tags' names.
- MDX files can switch to the rendered Markdown view, like other Markdown files.
- When a branch is behind its Base, the Base's heading in the branch's column says how many commits ahead it is, with a Restack button. Restack moves the branch, and the branches built on it, onto the Base at once, with Undo.
- `lane pull --restack` restacks published branches too, as every pull used to.
- When the header's column tabs don't all fit, the mouse wheel scrolls along them, the focused column's tab scrolls into view, and a menu beside them lists every open column.

### Changed

- Diffs wrap long lines by default. Turning wrapping off still applies to every diff until Laneway restarts.
- Markdown files' diffs show the rendered documents by default. Switching a diff to its source lines still applies to every Markdown diff until Laneway restarts.
- Worktree columns and their tabs are named for the branch checked out in them, rather than the worktree's folder, whose path still shows under the name. A detached worktree's column keeps its folder's name. Rename a worktree from its column's actions menu.
- Check out in, and choosing where to apply a stash, list each worktree by its branch first.
- Pull latest no longer restacks a published branch just because the Primary Branch moved forward, so a pull no longer leaves it needing a Force publish. The branch still gets the new commits from its own remote branch, and Restack moves it when you want it moved. A branch with a published branch built on it stays put too; branches with nothing published restack as before.
- When a branch's column closes because the branch no longer exists, the notice names the branch.
- The Staged divider in Working Changes has an arrow pointing up at the staged files above it.
- Clicking a file in a column selects it, instead of opening its diff underneath it; Ctrl+click still adds files to the selection. Double-click a file, press Enter on it, or use the button that appears when you hover it to open the diff column beside the column. While the diff column is open, clicking a file also scrolls to it.
- A column can only be maximized while its diff column is open, and closing the diff column restores the column's width.
- Clicking a file in a branch comparison column opens the diff column, as double-clicking it does elsewhere.
- Clicking a file in a commit diff column opens the commit's diff in a diff column beside it, scrolled to that file, instead of showing the file's diff under its row.
- A commit diff column opens as wide as a branch column.
- A diff column that opens scrolls into view beside the column it came from. If the two don't fit side by side, the column it came from stays in view.
- Switching repositories is faster, especially to one with a diff column open. Each repository you switch back to shows its columns, diffs, and scroll positions as you left them.
- Expanding a collapsed column scrolls it into view.

### Fixed

- Pull latest brings in a remote branch's new commits when another tool fetched them first. Before, a branch whose remote branch had been rewritten or had moved alongside it looked up to date, and offered a Force publish that would have discarded those commits.
- An open diff no longer says "File changed. Change Selection cleared." when its file changes with no lines selected, and the message goes away once you select lines again.
- Opening the diff of a file that was renamed without changes no longer leaves a blank window.
- Pull latest no longer stays highlighted after a pull restacks a branch onto its Base. The commits the restack replaced on the remote branch aren't new; the branch is ready to publish instead.
- Publish works out what it would push much faster in repositories with many branches, and the Branch Graph loads faster there too, after a commit conflict.
- A conflicted commit's file actions stay in view when its column is narrowed, instead of being cut off at the column's edge.
- The Branch Graph now shows a merged branch joining the Primary Branch even when another branch is stacked on top of it.
- Rewording a commit, rebasing a branch, moving changes between commits, and applying a Historical Edit no longer fail when a commit hook needs installed tools such as `node_modules`. Commit hooks no longer run on each rewritten commit. Instead, the pre-commit hook checks the result afterwards in each worktree whose files changed. If it fails, the notice stays open with the hook's output, and Undo reverses the change.

## v0.1.0-alpha.1

The first alpha release.
