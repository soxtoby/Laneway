import type { BranchGraphReadOptions, BranchHistoryRequest, ChangesRequest, DiffSource, FileDiffRequest, FileImageRequest } from "@laneway/shared"
import { access, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { type BranchGraphReadCache, startBranchGraphRead, startBranchHistoryRead } from "./branch-graph"
import { type ChangesReadCache, startChangesRead, startFileDiffRead, startFileImageRead } from "./changes"
import { conflictComparisonSource, conflictHistoryRequest, projectConflictGraph } from "./conflict-graph"
import { GitError } from "./git-error"
import { selectGit } from "./git-installation"
import { commandFailure, type GitRunResult, redactGitText, runGitProcess, startGitProcess } from "./git-process"
import { readRegisteredWorktrees } from "./worktrees"

export { GitError, type GitErrorCode } from "./git-error"
export { parseGitVersion, selectGit } from "./git-installation"
export { redactGitText } from "./git-process"

export type ObjectFormat = "sha1" | "sha256"
declare const objectIdBrand: unique symbol
export type ObjectId = string & { readonly [objectIdBrand]: true }

export interface GitInstallation {
    path: string
    version: string
}

type GitSelection = GitInstallation | string | undefined

export interface RepositoryDescriptor {
    id: string
    root: string
    mainWorktree: string
    selectedWorktree: string
    commonDirectory: string
    gitDirectory: string
    objectFormat: ObjectFormat
    shallow: boolean
    partial: boolean
    sparse: boolean
    git: GitInstallation
}

export interface RefUpdate {
    ref: string
    before: string | null
    after: string | null
}

export interface WorktreeGitState {
    index: Uint8Array
    status: Uint8Array
    diff: Uint8Array
    untracked: string[]
}

export interface GitTask<T> {
    result: Promise<T>
    cancel(): void
}

export class RepositoryGit {
    private branchGraphCache: BranchGraphReadCache | undefined
    private readonly changesCache: ChangesReadCache = new Map()

    constructor(readonly descriptor: RepositoryDescriptor) {}

    private get readDescriptor() {
        return { ...this.descriptor, selectedWorktree: this.descriptor.mainWorktree }
    }

    startReadChanges(request: ChangesRequest) {
        return this.withConflictComparison(request, prepared =>
            startChangesRead(
                this.readDescriptor,
                (cwd, args, onOutput, input) => startGitProcess({ installation: this.descriptor.git, cwd, args, readOnly: true, onOutput, input }),
                prepared,
                this.changesCache,
            ))
    }

    startReadFileHistory(request: FileHistoryRequest) {
        return startFileHistoryRead(
            this.readDescriptor,
            (cwd, args) => startGitProcess({ installation: this.descriptor.git, cwd, args, readOnly: true }),
            request,
        )
    }

    startReadFileDiff(request: FileDiffRequest) {
        return this.withConflictComparison(request, prepared =>
            startFileDiffRead(
                this.readDescriptor,
                (cwd, args, onOutput, input) => startGitProcess({ installation: this.descriptor.git, cwd, args, readOnly: true, onOutput, input }),
                prepared,
                this.changesCache,
            ))
    }

    startReadFileImage(request: FileImageRequest) {
        return this.withConflictComparison(request, prepared =>
            startFileImageRead(
                this.readDescriptor,
                (cwd, args, onOutput, input) => startGitProcess({ installation: this.descriptor.git, cwd, args, readOnly: true, onOutput, input }),
                prepared,
                this.changesCache,
            ))
    }

    private withConflictComparison<T extends { source: DiffSource }, R>(request: T, start: (prepared: T) => GitTask<R>): GitTask<R> {
        if (request.source.kind != "branches")
            return start(request)

        let source = request.source
        let task: GitTask<R> | undefined
        let cancelled = false

        return {
            cancel: async () => {
                cancelled = true
                await task?.cancel()
            },
            result: (async () => {
                let prepared = await conflictComparisonSource(this, source)
                if (cancelled)
                    throw new GitError("git.cancelled", "Comparison loading cancelled.")
                task = start({ ...request, source: prepared })
                return task.result
            })(),
        }
    }

    async hashObject(value: string) {
        let objectId = await this.requireText(this.descriptor.selectedWorktree, ["hash-object", "-w", "--stdin"], value)
        this.validateObjectId(objectId)
        return objectId as ObjectId
    }

    async resolveRef(ref: string) {
        let result = await this.run(this.descriptor.selectedWorktree, ["rev-parse", "--verify", "--quiet", ref])
        if (result.exitCode == 1)
            return null

        this.throwIfFailed(result, `Could not read ${ref}.`)
        let objectId = result.stdout.toString().trim()
        this.validateObjectId(objectId)
        return objectId as ObjectId
    }

    async listRefs(prefix: string) {
        let output = await this.requireText(this.descriptor.selectedWorktree, ["for-each-ref", "--format=%(refname)", prefix])
        return output.split("\n").filter(Boolean)
    }

    async updateRef(ref: string, objectId: string | null) {
        if (objectId)
            this.validateObjectId(objectId)

        let args = objectId ? ["update-ref", ref, objectId] : ["update-ref", "-d", ref]
        let result = await this.run(this.descriptor.selectedWorktree, args)
        this.throwIfFailed(result, objectId ? `Could not update ${ref}.` : `Could not delete ${ref}.`)
    }

    async updateRefs(changes: RefUpdate[]) {
        let zeroObjectId = "0".repeat(this.descriptor.objectFormat == "sha1" ? 40 : 64)
        let commands = ["start"]

        for (let change of changes) {
            if (change.before)
                this.validateObjectId(change.before)
            if (change.after)
                this.validateObjectId(change.after)
            if (change.after)
                commands.push(`update ${change.ref} ${change.after} ${change.before ?? zeroObjectId}`)
            else if (change.before)
                commands.push(`delete ${change.ref} ${change.before}`)
        }

        commands.push("prepare", "commit", "")
        let result = await this.run(this.descriptor.selectedWorktree, ["update-ref", "--stdin"], commands.join("\n"))
        this.throwIfFailed(result, "Repository refs changed before Laneway could update them.")
    }

    async readWorktreeState(worktree: string): Promise<WorktreeGitState> {
        let [index, status, diff, untracked] = await Promise.all([
            this.requireBytes(worktree, ["ls-files", "--stage", "-v", "-z"]),
            this.requireBytes(worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]),
            this.requireBytes(worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"]),
            this.requireBytes(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
        ])
        return {
            index,
            status,
            diff,
            untracked: Buffer.from(untracked).toString().split("\0").filter(Boolean),
        }
    }

    startReadBranchGraph(options: BranchGraphReadOptions) {
        let task = startBranchGraphRead(
            this.descriptor,
            (args, input) => startGitProcess({ installation: this.descriptor.git, cwd: this.descriptor.mainWorktree, args, input }),
            options,
            this.branchGraphCache,
            cache => this.branchGraphCache = cache,
        )
        return {
            cancel: task.cancel,
            result: task.result.then(async graph => {
                let worktrees = await readRegisteredWorktrees(this)
                let enrich = (item: { path: string }) =>
                    worktrees.find(worktree => worktree.path.replaceAll("\\", "/").toLowerCase() == item.path.replaceAll("\\", "/").toLowerCase()) ?? item
                for (let branch of graph.branches)
                    branch.checkedOut = branch.checkedOut.map(item => ({ ...item, ...enrich(item) }))
                for (let branch of graph.virtualBranches)
                    branch.worktree = { ...branch.worktree, ...enrich(branch.worktree) }

                return projectConflictGraph(this, graph)
            }),
        }
    }

    startReadBranchHistory(request: BranchHistoryRequest) {
        let task: ReturnType<typeof startBranchHistoryRead> | undefined
        let cancelled = false
        return {
            cancel: async () => {
                cancelled = true
                await task?.cancel()
            },
            result: (async () => {
                let prepared = await conflictHistoryRequest(this, request)
                if (cancelled)
                    throw new GitError("git.cancelled", "History loading cancelled.")
                task = startBranchHistoryRead(
                    this.descriptor,
                    (args, input) => startGitProcess({ installation: this.descriptor.git, cwd: this.descriptor.mainWorktree, args, input }),
                    prepared.request,
                )
                return prepared.decorate(await task.result)
            })(),
        }
    }

    run(cwd: string, args: string[], input?: string | Uint8Array, env?: Record<string, string>) {
        return runGitProcess({ installation: this.descriptor.git, cwd, args, input, env })
    }

    async command(cwd: string, args: string[], input?: string | Uint8Array, env?: Record<string, string>) {
        let result = await this.run(cwd, args, input, env)
        this.throwIfFailed(result, "Git command failed.")
        return result.stdout
    }

    private async requireText(cwd: string, args: string[], input?: string) {
        return Buffer.from(await this.requireBytes(cwd, args, input)).toString().trim()
    }

    private async requireBytes(cwd: string, args: string[], input?: string) {
        let result = await this.run(cwd, args, input)
        this.throwIfFailed(result, "Git command failed.")
        return new Uint8Array(result.stdout)
    }

    private throwIfFailed(result: GitRunResult, fallback: string) {
        if (result.exitCode == 0)
            return
        throw commandFailure(result, fallback)
    }

    private validateObjectId(objectId: string) {
        let length = this.descriptor.objectFormat == "sha1" ? 40 : 64
        if (!new RegExp(`^[0-9a-f]{${length}}$`).test(objectId))
            throw new GitError("git.command-failed", `Git returned an invalid ${this.descriptor.objectFormat} object ID.`)
    }
}
import type { FileHistoryRequest } from "@laneway/shared"
import { startFileHistoryRead } from "./file-history"
export * from "./conflicts"
export * from "./worktrees"

export async function initializeRepository(options: { path: string; gitPath?: string; git?: GitInstallation; initialBranch?: string }) {
    let installation = await resolveGitSelection(options.git ?? options.gitPath)
    let path = resolve(options.path)
    await mkdir(path, { recursive: true })

    let args = ["init"]
    if (options.initialBranch)
        args.push(`--initial-branch=${options.initialBranch}`)
    args.push("--", path)

    let result = await runGitProcess({ installation, args })
    if (result.exitCode != 0)
        throw commandFailure(result, "Git could not initialize the directory.")

    return openRepository(path, installation)
}

export function isLikelyCloneSource(text: string) {
    let candidate = text.trim()
    if (!candidate || /\s/.test(candidate))
        return false
    return /^(?:https?|ssh|git|git\+ssh|ssh\+git|file):\/\/\S+$/i.test(candidate)
        || /^[\w.-]+@[\w.-]+:\S+$/.test(candidate)
        || /^[\w-]+(?:\.[\w-]+)+:\S+$/.test(candidate)
}

export function inferCloneDirectoryName(source: string) {
    let withoutQuery = source.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "")
    let tail = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf(":")) + 1)
    let name = tail.replace(/\.git$/i, "")
    return name || "repository"
}

export async function startCloneRepository(options: {
    source: string
    destination: string
    gitPath?: string
    git?: GitInstallation
    onProgress?: (message: string) => void
}): Promise<GitTask<RepositoryGit>> {
    let installation = await resolveGitSelection(options.git ?? options.gitPath)
    let source = options.source.trim()
    let destination = resolve(options.destination)
    if (!source)
        throw new GitError("git.command-failed", "A clone source is required.")

    let destinationExisted = true
    try {
        let entries = await readdir(destination)
        if (entries.length > 0)
            throw new GitError("git.destination-conflict", `The clone destination is not empty: ${destination}.`, { destination })
    } catch (error) {
        if (error instanceof GitError)
            throw error
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            destinationExisted = false
        else
            throw new GitError("git.destination-conflict", `Laneway cannot use the clone destination: ${destination}.`, { destination })
    }

    let execution = startGitProcess({
        installation,
        args: ["clone", "--progress", "--", source, destination],
        secrets: [source],
        onProgress: options.onProgress,
    })
    return {
        cancel: execution.cancel,
        result: (async () => {
            let result = await execution.result
            if (execution.wasCancelled()) {
                throw new GitError("git.cancelled", "Clone cancelled. The partial destination was preserved.", {
                    destination,
                    createdDestination: !destinationExisted,
                })
            }
            if (result.exitCode != 0) {
                let failure = commandFailure(result, "Git could not clone the repository.", [source])
                throw new GitError(failure.code, failure.message, {
                    ...failure.details,
                    destination,
                    createdDestination: !destinationExisted,
                })
            }
            return openRepository(destination, installation)
        })(),
    }
}

export async function openRepository(path: string, git?: GitSelection) {
    return connectRepository(path, git, true)
}

export async function connectRepository(path: string, git?: GitSelection, requireExactRoot = false) {
    let installation = await resolveGitSelection(git)
    let selectedPath = resolve(path)
    let selectedDirectory: string

    try {
        if (!(await lstat(selectedPath)).isDirectory())
            throw new Error("not a directory")
        selectedDirectory = await realpath(selectedPath)
    } catch {
        throw new GitError("git.invalid-root", `The selected path is not a valid Git repository root: ${selectedPath}.`, { path: selectedPath })
    }

    let [bare, details, worktreesResult, partialResult, sparseResult] = await Promise.all([
        runGitProcess({ installation, cwd: selectedDirectory, args: ["rev-parse", "--is-bare-repository"] }),
        runGitProcess({
            installation,
            cwd: selectedDirectory,
            args: [
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-common-dir",
                "--git-dir",
                "--show-object-format=storage",
                "--is-shallow-repository",
            ],
        }),
        runGitProcess({ installation, cwd: selectedDirectory, args: ["worktree", "list", "--porcelain", "-z"] }),
        runGitProcess({ installation, cwd: selectedDirectory, args: ["config", "--get-regexp", "^remote\\..*\\.promisor$"] }),
        runGitProcess({ installation, cwd: selectedDirectory, args: ["config", "--bool", "--get", "core.sparseCheckout"] }),
    ])
    if (bare.exitCode != 0 && await hasMissingLinkedWorktreeTarget(selectedDirectory)) {
        throw new GitError(
            "git.missing-main-worktree",
            "This linked worktree points to a missing Main Worktree. Locate the Main Worktree before opening this repository.",
            { path: selectedPath },
        )
    }
    if (bare.exitCode != 0)
        throw invalidRoot(selectedPath)
    if (bare.stdout.toString().trim() == "true") {
        throw new GitError(
            "git.bare-repository",
            "Bare repositories are unsupported because Laneway requires a Main Worktree for changes, columns, and recovery.",
            { path: selectedPath },
        )
    }
    if (details.exitCode != 0)
        throw commandFailure(details, "Git could not inspect the repository.")
    if (worktreesResult.exitCode != 0)
        throw commandFailure(worktreesResult, "Git could not list Registered Worktrees.")

    let [rootResult, commonResult, gitDirectoryResult, formatResult, shallowResult] = details.stdout.toString().trim().split(/\r?\n/)
    if (!rootResult || !commonResult || !gitDirectoryResult || !formatResult || !shallowResult)
        throw new GitError("git.command-failed", "Git returned incomplete repository details.")

    let root = await canonicalDirectory(rootResult)
    if (requireExactRoot && !samePath(root, selectedDirectory))
        throw invalidRoot(selectedPath)
    let commonDirectory = await canonicalDirectory(commonResult)
    let gitDirectory = await canonicalDirectory(gitDirectoryResult)
    let worktrees = parseWorktreeRoots(worktreesResult.stdout.toString().trim())
    let mainWorktree = worktrees[0]
    if (!mainWorktree) {
        throw new GitError(
            "git.missing-main-worktree",
            "Git did not report a Main Worktree. Locate the Main Worktree before opening this repository.",
            { path: selectedPath },
        )
    }

    try {
        await access(mainWorktree)
    } catch {
        throw new GitError(
            "git.missing-main-worktree",
            `The Main Worktree is missing at ${mainWorktree}. Locate it before opening this repository.`,
            { path: selectedPath, mainWorktree },
        )
    }

    let objectFormat = formatResult.trim()
    if (objectFormat != "sha1" && objectFormat != "sha256") {
        throw new GitError(
            "git.unsupported-format",
            `Laneway does not support Git object format "${redactGitText(objectFormat)}". Supported formats are SHA-1 and SHA-256.`,
            { objectFormat: redactGitText(objectFormat) },
        )
    }

    let descriptor: RepositoryDescriptor = {
        id: commonDirectory,
        root,
        mainWorktree,
        selectedWorktree: root,
        commonDirectory,
        gitDirectory,
        objectFormat,
        shallow: shallowResult.trim() == "true",
        partial: partialResult.exitCode == 0 && partialResult.stdout.length > 0,
        sparse: sparseResult.exitCode == 0 && sparseResult.stdout.toString().trim() == "true",
        git: installation,
    }

    return new RepositoryGit(descriptor)
}

function resolveGitSelection(git: GitSelection) {
    return typeof git == "object" ? Promise.resolve(git) : selectGit(git)
}

function invalidRoot(path: string) {
    return new GitError("git.invalid-root", `The selected path is not a valid Git repository root: ${path}.`, { path })
}

async function hasMissingLinkedWorktreeTarget(path: string) {
    let marker: string
    try {
        marker = await readFile(resolve(path, ".git"), "utf8")
    } catch {
        return false
    }

    let match = /^gitdir:\s*(.+)\s*$/i.exec(marker.trim())
    if (!match)
        return false

    let target = isAbsolute(match[1]) ? match[1] : resolve(path, match[1])
    try {
        await access(target)
        return false
    } catch (error) {
        return (error as NodeJS.ErrnoException).code == "ENOENT"
    }
}

async function canonicalDirectory(path: string) {
    return realpath(isAbsolute(path) ? path : resolve(path))
}

function samePath(left: string, right: string) {
    return process.platform == "win32" ? left.toLocaleLowerCase() == right.toLocaleLowerCase() : left == right
}

function parseWorktreeRoots(output: string) {
    return output.split("\0\0")
        .map(record => record.split("\0").find(line => line.startsWith("worktree "))?.slice("worktree ".length))
        .filter((value): value is string => Boolean(value))
        .map(value => resolve(value))
}
