let common = `
Options: --json, --git-path <executable>, --no-wait, -C <directory>, -h/--help.
Put these before a Git wrapper command; its remaining arguments belong to Git.`

let topics: Record<string, string> = {
    commit: "lane [options] commit [git commit arguments]\nCommit the staged snapshot. Git owns messages, editors, hooks, signing, and options.",
    stage: "lane [options] stage [git add arguments]\nAlias for git add, including -p, -A, and -- <paths>.",
    unstage: "lane [options] unstage [git restore arguments]\nAlias for git restore --staged. Use -- <paths> or . for all files.",
    branch: "lane [options] branch [git branch arguments]\nGit branch syntax: branch <name>, branch -m <old> <new>, branch -d <name>, branch --list.",
    stash: "lane [options] stash [git stash arguments]\nGit stash syntax and semantics, including push, apply, pop, drop, and list.",
    move: compositionHelp("move"),
    copy: compositionHelp("copy"),
    rebase: `lane rebase <branch> --onto <branch> [--preview] [--yes] [--allow-conflicts]
Rebase a branch and its descendants using Laneway composition.`,
    reword: `lane reword <commit> -m <message> [--branch <branch>] [--preview] [--yes]
Reword a commit and restack dependent history. Accepts Git revisions such as HEAD~2.
Repeat -m for paragraphs, or use -F <message-file>. Branch defaults to the current branch.
--yes approves rewriting published history or removing empty commits.`,
    worktree: `lane worktree create [branch] [--commit <revision>] [--move]
lane worktree switch <branch> [--path <worktree>] [--move]
lane worktree rename <path> <basename>
lane worktree repair <path> <destination>
lane worktree remove <path> [--discard] [--allow-ignored-loss]
lane worktree unlock <path>
lane worktree list
Paths resolve from the current directory. Switch defaults to the current worktree.
Removal preserves Working Changes and Worktree-only Commits unless --discard is given.
--move approves transferring a branch held by another worktree.`,
    pull: `lane pull [branch ...] [--remote <remote>]
Fetch and synchronize the named Active Stacks, including their bases and upstreams.
With no branches, use the current branch. This does not publish.`,
    publish: `lane publish [branch] [--remote <remote>] [--preview]
lane publish --resume <receipt>
lane publish --restore <receipt>
Publish the changed branches of the named Active Stack, or the current branch's, excluding its Base.
Branches without an upstream create same-named branches on --remote (default: the selected remote).
Every update carries an exact force-with-lease from the remote-tracking refs; a stale lease
publishes nothing, so pull and publish again. --preview lists every destination.
--resume finishes an interrupted or partial publish from its receipt; --restore force-publishes
the remote tips that receipt replaced. Publishing is never part of undo.`,
    conflict: `lane conflict list
lane conflict inspect <subject> [--file <path> ...]
lane conflict choose <subject> <file> --side <left|right|base|delete|suggestion> [--hunk <index>]
lane conflict use-file <subject> <file> <resolved-file>
lane conflict edit <subject> <file> --content-file <file>
lane conflict tool <subject> <file>
lane conflict accept|cancel|keep-stashed <subject>
lane conflict resume-working <subject> [--path <worktree>]
lane conflict restore <stack> [--path <worktree>] [--adopt <branch>]
lane conflict discard <stack>
lane conflict publish-check <branch ...>
lane conflict rewrite <branch ...> --onto <revision> [--path <worktree>]
Subject and stack IDs come from list/inspect. Candidate versions are read automatically.`,
    edit: `lane edit enter <commit> [--path <worktree>]
lane edit apply [--file <path> ...] [--view combined|staged|unstaged] [--yes] [--allow-conflicts]
lane edit return [--drop | --bring]
lane edit restart
lane edit status
Historical Edit: edit from an older commit of the current branch in this worktree.
Enter preserves Working Changes as a stash on the branch and checks out the commit detached.
Apply moves Historical Working Changes into that commit, keeping its author and message,
and restacks descendants; it is undoable. Return restores the earlier Working Changes on the
branch's current tip; with changes left, choose --drop or --bring (each undoable).
Restart re-pins a session whose branch moved outside it.`,
    undo: "lane undo [--worktree-basename <name>]\nUndo the latest eligible Laneway Operation, including Git wrappers.",
    redo: "lane redo\nRedo the next eligible Laneway Operation.",
    history: "lane history\nShow the repository's persistent operation history and undo/redo position.",
    recover: "lane recover [restore|remove <operation-id>]\nRecover interrupted operations, or resolve one worktree recovery explicitly.",
    "recovery-status": "lane recovery-status\nList worktrees requiring recovery and their operation IDs.",
    echo: "lane echo [message] [--delay-ms <milliseconds>] [--json]\nExercise engine output and cancellation.",
}

export function commandHelp(topic?: string) {
    if (topic && !topics[topic])
        throw new Error(`Unknown help topic "${topic}".`)
    return topic
        ? topics[topic] + "\n" + common
        : `Usage: lane [options] <command> [arguments]

Git commands with Laneway undo:
  commit, stage, unstage, branch, stash

Laneway workflows:
  move, copy        Transfer changes between worktrees, commits, and branches
  rebase           Rebase a branch and its descendants
  reword           Edit a commit message and restack descendants
  worktree         Create, switch, rename, repair, remove, unlock, list
  pull             Fetch and synchronize Active Stacks
  publish          Publish an Active Stack, resume, or restore from a receipt
  conflict         Inspect and resolve deferred conflicts
  edit             Edit from an older commit: enter, apply, return, restart, status
  undo, redo       Navigate operation history
  history          List operations
  recover          Recover interrupted operations
  recovery-status  Inspect pending worktree recovery

Run lane <command> --help for syntax. --version prints the engine version.
Git wrappers preserve Git behavior and record operation-specific undo.
Undo checks affected state; unrelated edits are preserved.
${common}`
}

function compositionHelp(mode: string) {
    return `lane ${mode} --from <source> --to <target> [--file <path> ...] [-m <message>]
Sources: working[:path], commit:<revision>, branch:<name>
Targets: working[:path], commit:<revision>, after:<revision>, branch:<name>
Use --source-branch/--target-branch when commit ownership differs from the current branch.
--file selects whole files; omit it for all changes. Paths are repository-relative.
--view combined|staged|unstaged selects Working Changes (default combined).
--preview prints the plan. --yes approves published rewrites or empty commit removal.
--allow-conflicts permits deferred conflicts. --no-descendants excludes descendants.
Example: lane ${mode} --from working --to commit:HEAD --file src/app.ts`
}
