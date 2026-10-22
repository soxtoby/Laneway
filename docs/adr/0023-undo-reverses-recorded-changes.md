---
status: accepted
---

# Undo reverses recorded changes

A Laneway Operation records the changes it makes, and undo applies their inverse to the repository as it is now. Undo is the reverse operation, not a return to a point in time. This supersedes the checkpoint model of [ADR 0017](0017-recover-operations-from-git-checkpoints.md) for undo, redo, and interruption recovery; object retention stays as [ADR 0014](0014-retain-operation-objects-in-protected-packs.md) describes.

Under ADR 0017 every operation captured a whole-repository checkpoint before planning, again before mutating, and again afterwards, fingerprinting every registered worktree each time, and undo restored the first capture with forced checkouts after refusing if anything differed from the last. A reword with two linked worktrees spent 54 of its 84 Git launches on those captures, and rewording a commit, editing a file, then undoing was refused with "Repository state changed outside Laneway". Laneway's pitch is fast history manipulation where undo replaces confirmation, so operations must be cheap and undo must work in the repository the user actually has, including edits made since.

## Recorded changes

An operation records each change as it makes it: a ref moved from one object to another, including `refs/stash` and Laneway's own state refs; a worktree's HEAD moved from one commit or branch to another; a worktree's index or files replaced from one tree by another; a stash entry created or dropped; a branch configuration key changed; a worktree registered, moved, or removed, with the removed directory's retained snapshot; and a metadata entry changed. An operation that recorded nothing never enters Operation History. Native Git wrappers already record inverses this way ([ADR 0018](0018-expose-terminal-workflows-and-undoable-git-wrappers.md)), and this decision makes that the shape of every operation.

## Reversal

Undo applies the inverse of each recorded change, and redo applies the changes again; both record what they did the same way. Refs move in one Git transaction whose expected old values are the values the operation left, so Git itself refuses the whole undo when a branch has moved outside Laneway, and that operation's undo is reported unavailable naming the branch. This is the only check undo makes: Git provides it at no cost, and moving a branch out from under commits made since would discard them. A worktree whose HEAD still sits where the operation left it moves back; one that has since checked out something else is left alone while its branch still moves. Index and file changes are reversed by merging the earlier tree over the current index and files, which keeps Working Changes on other paths in place. Where Working Changes touch the same paths, they are stashed first under the existing Working Changes contract and reapplied afterwards, becoming a Working Changes Conflict if they no longer apply cleanly. Nothing is force-checked-out or cleaned. Ignored files stay outside undo ([ADR 0022](0022-treat-ignored-files-as-git-does.md)).

Changes made outside Laneway to anything but the refs an operation moved are not detected and not guarded against. Undo applies the inverse on top of them, and when that produces an odd result the user undoes or fixes it like any other change. That trade is deliberate: the guard cost every operation several worktree walks and refused the common case of editing after an operation, to protect against a rare one.

## Interruption recovery

The ref transaction is an operation's commit point. Changes recorded before it are reversed by the next Engine run if the transaction never happened; once it has, the remaining worktree changes are completed from the record and the operation is entered in history. The journal therefore records each change as it lands rather than the six phases ADR 0017 required, and recovery never needs a capture to decide what to do.

## Consequences

The pre-mutation verification between a preview and its confirmed apply goes with the checkpoints; the ref transaction's expected values are the check that remains. Operations previously recorded with checkpoints stay undoable through the checkpoint reader until they leave the history window, as ADR 0017 kept ADR 0011's entries readable. Tests that asserted refusal after an external edit assert preservation instead. Operation cost becomes proportional to what the operation touches, so a reword on a repository with linked worktrees is a handful of launches rather than dozens, and the per-process read memo matters less than it did.
