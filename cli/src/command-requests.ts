import { connectRepository, type RepositoryGit } from "@laneway/git"
import type { CompositionTarget, ConflictRequest, LocalRequest, WorktreeRequest } from "@laneway/shared"
import { readFile } from "node:fs/promises"
import { posix, resolve } from "node:path"
import { type Arguments, flag, multiple, operands, option, requiredOption, UsageError } from "./command-arguments"
import type { OperationCommand, OperationCommandResult } from "./operations/operation-runtime"

export async function compositionRequest(command: string, args: Arguments, repo: RepositoryGit, cwd: string): Promise<LocalRequest> {
    let branch = () => currentBranch(repo)
    if (command == "reword") {
        let [revision] = operands(args, 1)
        let message = await commitMessage(args, cwd)
        if (!message.trim())
            throw new UsageError("Provide a commit message with -m or -F.")
        let [title, ...body] = message.trim().split("\n")
        return {
            action: "reword",
            objectId: await commitId(repo, revision!),
            branch: option(args, "branch") ?? await branch(),
            title: title!,
            message: body.join("\n").trim(),
            selectedRemote: option(args, "remote"),
        }
    } else {
        operands(args, command == "rebase" ? 1 : 0)
        let source = command == "rebase" ? `branch:${args.positionals[0]}` : requiredOption(args, "from")
        let target = command == "rebase" ? `branch:${requiredOption(args, "onto")}` : requiredOption(args, "to")
        let from = await endpoint(source, option(args, "source-branch"), repo, cwd)
        if (from.kind == "seam")
            throw new UsageError("An after:<revision> endpoint is only valid as a destination.")
        let files = multiple(args, "file").map(gitFilePath)
        let view = option(args, "view") ?? "combined"
        if (view != "combined" && view != "staged" && view != "unstaged")
            throw new UsageError("--view must be combined, staged, or unstaged.")
        return {
            action: "compose",
            mode: command == "copy" ? "copy" : "move",
            source: from,
            target: await endpoint(target, option(args, "target-branch"), repo, cwd),
            files: files.length ? files.map(path => ({ path })) : undefined,
            message: await commitMessage(args, cwd),
            view,
            descendants: !flag(args, "no-descendants"),
            allowConflicts: flag(args, "allow-conflicts"),
            selectedRemote: option(args, "remote"),
        }
    }
}

export async function worktreeRequest(action: string, args: Arguments, repo: RepositoryGit, cwd: string): Promise<WorktreeRequest> {
    if (action == "create") {
        let [branch] = operands(args, 0, 1)
        let commit = option(args, "commit")
        return { action, branch, commit: commit ? await commitId(repo, commit) : undefined, move: flag(args, "move") }
    } else if (action == "switch") {
        let [branch] = operands(args, 1)
        return { action, branch: branch!, path: await worktreePath(repo, cwd, option(args, "path")), move: flag(args, "move") }
    } else if (action == "rename") {
        let [path, basename] = operands(args, 2)
        return { action, path: resolve(cwd, path!), basename: basename! }
    } else if (action == "repair") {
        let [path, destination] = operands(args, 2)
        return { action, path: resolve(cwd, path!), destination: resolve(cwd, destination!) }
    } else if (action == "remove") {
        let [path] = operands(args, 1)
        return { action, path: resolve(cwd, path!), preserve: !flag(args, "discard"), allowIgnoredLoss: flag(args, "allow-ignored-loss") }
    } else if (action == "unlock") {
        let [path] = operands(args, 1)
        return { action, path: resolve(cwd, path!) }
    } else {
        throw new UsageError(`Unknown worktree action "${action}". Use lane worktree --help.`)
    }
}

export async function conflictRequest(
    action: string,
    args: Arguments,
    repo: RepositoryGit,
    cwd: string,
    execute: (command: OperationCommand) => Promise<OperationCommandResult>,
): Promise<ConflictRequest> {
    if (action == "list") {
        operands(args, 0)
        return { action }
    } else if (action == "inspect") {
        let [subject] = operands(args, 1)
        let files = multiple(args, "file").map(gitFilePath)
        return { action, subject: subject!, files: files.length ? files : undefined }
    } else if (action == "publish-check" || action == "rewrite") {
        let branches = operands(args, 1, Infinity)
        return action == "publish-check"
            ? { action, branches }
            : {
                action,
                branches,
                base: await commitId(repo, requiredOption(args, "onto")),
                path: option(args, "path") ? await worktreePath(repo, cwd, option(args, "path")) : undefined,
            }
    } else if (action == "restore" || action == "discard") {
        let [stack] = operands(args, 1)
        return action == "discard"
            ? { action, stack: stack! }
            : {
                action,
                stack: stack!,
                path: option(args, "path") ? await worktreePath(repo, cwd, option(args, "path")) : undefined,
                adopt: option(args, "adopt"),
            }
    } else if (action == "resume-working") {
        let [subject] = operands(args, 1)
        return { action, subject: subject!, path: await worktreePath(repo, cwd, option(args, "path")) }
    } else {
        let count = action == "use-file" ? 3 : ["choose", "edit", "tool"].includes(action) ? 2 : 1
        let [subject, fileArgument, path] = operands(args, count)
        let file = fileArgument == undefined ? undefined : gitFilePath(fileArgument)
        let inspected = await execute(
            { command: "conflict", request: { action: "inspect", subject: subject! }, noWait: flag(args, "no-wait") },
        )
        if (inspected.command != "conflict" || !inspected.view)
            throw new UsageError("The conflict subject is no longer available.")
        let candidate = inspected.view.candidate
        let version = { subject: subject!, input: candidate.input, revision: candidate.revision }
        if (action == "choose") {
            let side = requiredOption(args, "side")
            if (!["left", "right", "base", "delete", "suggestion"].includes(side))
                throw new UsageError("Choose --side left, right, base, delete, or suggestion.")
            let hunk = option(args, "hunk")
            if (hunk != undefined && (!/^\d+$/.test(hunk) || !Number.isSafeInteger(Number(hunk))))
                throw new UsageError("--hunk must be a non-negative integer.")
            return {
                action,
                ...version,
                file: file!,
                side: side as Extract<ConflictRequest, { action: "choose" }>["side"],
                hunk: hunk == undefined ? undefined : Number(hunk),
            }
        } else if (action == "use-file")
            return { action, ...version, file: file!, path: resolve(cwd, path!) }
        else if (action == "edit")
            return { action, ...version, file: file!, content: await readFile(resolve(cwd, requiredOption(args, "content-file")), "utf8") }
        else if (action == "tool")
            return { action, ...version, file: file! }
        else if (action == "accept" || action == "cancel" || action == "keep-stashed")
            return { action, ...version }
        else
            throw new UsageError(`Unknown conflict action "${action}". Use lane conflict --help.`)
    }
}

export async function currentBranch(repo: RepositoryGit) {
    let result = await repo.run(repo.descriptor.selectedWorktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (result.exitCode)
        throw new UsageError("This worktree is detached. Specify a branch explicitly.")
    return result.stdout.toString().trim()
}

async function commitId(repo: RepositoryGit, revision: string) {
    return (await repo.command(repo.descriptor.selectedWorktree, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).toString().trim()
}

async function endpoint(value: string, owningBranch: string | undefined, repo: RepositoryGit, cwd: string): Promise<CompositionTarget> {
    let colon = value.indexOf(":")
    let kind = colon < 0 ? value : value.slice(0, colon)
    let name = colon < 0 ? "" : value.slice(colon + 1)
    if (kind == "working")
        return { kind, worktreePath: await worktreePath(repo, cwd, name || undefined) }
    else if (kind == "branch" && name)
        return { kind, branch: name, tip: await commitId(repo, name) }
    else if ((kind == "commit" || kind == "after") && name) {
        let objectId = await commitId(repo, name)
        let branch = owningBranch ?? await currentBranch(repo)
        return kind == "commit" ? { kind, objectId, branch } : { kind: "seam", parentId: objectId, branch }
    } else {
        throw new UsageError(`Invalid endpoint "${value}". Use working[:path], commit:<revision>, after:<revision>, or branch:<name>.`)
    }
}

async function worktreePath(repo: RepositoryGit, cwd: string, path?: string) {
    return path ? (await connectRepository(resolve(cwd, path), repo.descriptor.git.path)).descriptor.selectedWorktree : repo.descriptor.selectedWorktree
}

async function commitMessage(args: Arguments, cwd: string) {
    let messages = multiple(args, "message")
    let file = option(args, "message-file")
    if (file && messages.length)
        throw new UsageError("Use either -m or -F for the message.")
    return file ? readFile(resolve(cwd, file), "utf8") : messages.join("\n\n")
}

function gitFilePath(path: string) {
    return posix.normalize(process.platform == "win32" ? path.replaceAll("\\", "/") : path)
}
