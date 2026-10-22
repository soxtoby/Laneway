# Command line

Build with `bun run build:engine`. The executable is `cli/bin/lane.exe`.
Run `lane --help` or `lane <command> --help` for syntax.

## Git commands with undo

These commands call system Git with its native arguments, current directory, stdin,
stdout, stderr, hooks, editor, configuration, and exit code:

```sh
lane stage -- src/app.ts             # git add
lane stage -p                       # interactive Git staging
lane unstage -- src/app.ts           # git restore --staged
lane commit -m "Fix navigation"      # git commit; only staged changes by default
lane commit --amend
lane branch topic
lane branch -m topic renamed
lane branch -d renamed
lane stash push -u -m "Work in progress"
lane stash apply                    # keeps the stash
lane stash pop                      # drops it only on success
```

Undo records only the state relevant to each command:

- Commit: previous/new HEAD. Undo moves the ref back, leaving the index and files
  alone, like a soft reset. Amend restores the previous commit; undoing an initial
  commit restores an unborn branch.
- Stage/unstage: previous/new index, including unmerged entries. Explicit
  `unstage --worktree` also records the files Git restores.
- Branch: changed refs, branch configuration, reflogs, and renamed worktree HEADs.
- Stash: changed stash entries, index, and files in the current worktree. Stash
  objects and file contents needed for undo remain retained.

Git runs without a Laneway repository lock or interruption-recovery transaction.
A short lock coordinates recording the completed command in operation history.
Interruption between Git finishing and that write can leave an unrecorded action;
Laneway does not roll it back automatically. Undo/redo checks only the state it
will change, preserving unrelated edits. Retained objects survive Git garbage
collection.

Listing and unchanged outcomes do not add an operation or abandon redo history.
Failures preserve Git's exit code and resulting state. Commit-hook edits are not
part of commit undo. Existing Git merges and rebases do not block the wrappers.
Ignored files are included in stash undo when using `stash --all`.

Put Laneway options **before** a Git wrapper command so all following arguments
retain their Git meaning:

```sh
lane -C ../other-worktree commit -m "Fix"
lane --git-path /path/to/git branch --list
lane --json stash list
```

With `--json`, native stdout/stderr and the exit code are fields of a `git` result
event; diagnostics also go to stderr. Without it, terminal streams are inherited for editors and interactive
staging. Git wrappers do not consume the Engine's stdin cancellation protocol;
stdin belongs to Git.

## Laneway workflows

```sh
lane move --from working --to commit:HEAD --file src/app.ts
lane copy --from commit:HEAD~1 --to working
lane move --from working --to after:HEAD -m "Extract navigation fix"
lane rebase feature --onto main --preview
lane reword HEAD~2 -m "Clarify the earlier change"
lane pull feature another-feature
lane worktree create feature
lane worktree switch feature --path ../other-worktree --move
lane worktree rename ../old-name new-name
lane worktree remove ../other-worktree
lane conflict list
lane conflict inspect <subject-id>
lane conflict choose <subject-id> src/app.ts --side right
lane conflict use-file <subject-id> src/app.ts ./resolved-app.ts
lane conflict accept <subject-id>
lane edit enter HEAD~2
lane edit apply --file src/app.ts
lane edit return --bring
lane edit status
lane history
lane undo
lane redo
lane recovery-status
lane recover
```

Commit arguments accept Git revisions, including short hashes, tags, and `HEAD~2`.
Working paths resolve from the calling directory; file selections are relative to
the source worktree root. `working` means the current registered worktree, even
when invoked from a subdirectory. Commit ownership defaults to the current branch;
use `--source-branch`/`--target-branch` when transferring across branches.

`move`/`copy` sources are `working[:path]`, `commit:<revision>`, or `branch:<name>`.
Destinations also accept `after:<revision>` to insert a new commit. Repeat `--file`
to select whole files, or omit it for all changes. `--view staged|unstaged|combined`
selects the working snapshot. `rebase` is a branch-to-branch move.

`--preview` shows a composition plan without applying it. Published rewrites and
empty commit removal require `--yes`; deferred conflicts require
`--allow-conflicts`. The CLI acquires and validates preview tokens internally.
Conflict commands similarly read current candidate versions automatically and
reject concurrent changes. `-m` may be repeated for message paragraphs; `-F`
reads a message file.

`pull` defaults to the current branch's Active Stack and never publishes.
Worktree removal preserves Working Changes and Worktree-only Commits by default;
`--discard` opts out. `--allow-ignored-loss` explicitly permits deleting ignored
files. `recover restore|remove <operation-id>` resolves one pending worktree recovery.

`edit` is [Historical Edit](historical-edit.md) in the current worktree (or `--path`).
`enter <commit>` stashes Working Changes on the branch and checks the commit out detached;
`apply` moves Historical Working Changes into that commit and restacks descendants,
taking `--file`, `--view`, `--yes`, and `--allow-conflicts` like `move`. `return` restores
the earlier Working Changes on the branch's current tip; with changes left it needs
`--drop` or `--bring`. `restart` re-pins a stale session; `status` lists every session.
Entering, a clean return, and restarting are not operations; apply, drop, and bring are.

Laneway workflow commands accept `--json`, `--no-wait`, `--git-path`, and `-C`
before the command or among its options. `--no-wait` fails instead of waiting for
the repository operation lock.

