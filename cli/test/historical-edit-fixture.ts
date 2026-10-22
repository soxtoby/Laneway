import type { HistoricalEditRequest, HistoricalEditResult } from "@laneway/shared"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { conflict, createCompositionFixtures, git, perform, request } from "./composition-fixture"

export function createHistoricalEditFixtures() {
    let { fixture, cleanup: cleanupRepositories } = createCompositionFixtures()
    let directories: string[] = []

    return { stack, temporaryDirectory, cleanup }

    /** A feature branch of three commits on main, with a greeting its later commits build on. */
    async function stack() {
        let { path, base } = await fixture()
        let greeting = await commit(path, "greet.txt", "hello\nthere\nfriend\n", "Add a greeting", "2026-10-01T09:00:00Z")
        await commit(path, "print.txt", "print\n", "Print it")
        let tip = await commit(path, "greet.txt", "hello\nthere\npal\n", "Wave goodbye")
        return { path, base, greeting, tip }
    }

    async function temporaryDirectory() {
        let path = await mkdtemp(join(tmpdir(), "laneway-historical-edit-"))
        directories.push(path)
        return path
    }

    async function cleanup() {
        await cleanupRepositories()
        for (let path of directories.splice(0)) {
            if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
                throw new Error("Invalid fixture path")
            await rm(path, { recursive: true, force: true })
        }
    }
}

export async function commit(path: string, file: string, content: string, message: string, date?: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    let result = Bun.spawnSync(["git", "commit", "-qm", message], { cwd: path, env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date } : {}) } })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return git(path, "rev-parse", "HEAD")
}

export function edit(path: string, request: HistoricalEditRequest) {
    return executeOperationCommand({ command: "edit", request, noWait: false }, path) as Promise<HistoricalEditResult>
}

/** The Main Worktree's session, which is the fixture's own worktree. */
export async function session(path: string) {
    return (await edit(path, { action: "status" })).sessions.find(s => s.worktreeId == "main")
}

export async function apply(path: string, files?: string[], allowConflicts = false) {
    let current = (await session(path))!
    return perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "commit", objectId: current.commit, branch: current.branch },
            files: files?.map(file => ({ path: file })),
            message: "",
            allowConflicts,
        }),
    )
}

/** Resolves the only commit conflict with one side, by default the replayed commit's, and accepts it. */
export async function acceptSide(path: string, side: "left" | "right" = "right") {
    let [subject] = (await conflict(path, { action: "list" })).conflicts
    let view = (await conflict(path, { action: "inspect", subject: subject!.id })).view!
    let chosen = await conflict(path, {
        action: "choose",
        subject: subject!.id,
        input: view.subject.input,
        revision: view.candidate.revision,
        file: "greet.txt",
        side,
    })
    await conflict(path, { action: "accept", subject: subject!.id, input: view.subject.input, revision: chosen.view!.candidate.revision })
}

/** A commit on top of `parent`, as an external tool would make without checking anything out. */
export function externalCommit(path: string, parent: string) {
    return git(path, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "External")
}

export async function keepStashed(path: string, subject: string) {
    let view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "keep-stashed", subject, input: view.subject.input, revision: view.candidate.revision })
}

export async function history(path: string) {
    let result = await executeOperationCommand({ command: "history", noWait: false }, path)
    return result as Extract<typeof result, { command: "history" }>
}

export async function engine(path: string, args: string[], expected = 0) {
    let child = Bun.spawn([resolve(import.meta.dir, "../bin/lane.exe"), ...args, "--json"], {
        cwd: path,
        env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" },
        stdout: "pipe",
        stderr: "pipe",
    })
    let [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (exitCode != expected)
        throw new Error(`lane ${args[0]} exited ${exitCode}: ${stderr}`)
    return stdout
}
