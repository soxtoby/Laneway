# Changelog

## Unreleased

### Added

- Create a tag at a branch's tip or at any commit, from its menu in the Branch Graph or a column. The tag is created on the Branch Graph's remote too, and gets a message if you give it one.

### Fixed

- Opening the diff of a file that was renamed without changes no longer leaves a blank window.
- Pull latest no longer stays highlighted after a pull restacks a branch onto its Base. The commits the restack replaced on the remote branch aren't new; the branch is ready to publish instead.
- Publish works out what it would push much faster in repositories with many branches, and the Branch Graph loads faster there too, after a commit conflict.
- A conflicted commit's file actions stay in view when its column is narrowed, instead of being cut off at the column's edge.

## v0.1.0-alpha.1

The first alpha release.
