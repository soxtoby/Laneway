import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { conflict, git } from "./composition-fixture"

/** Repositories whose `topic` branch has a commit that conflicts with a newer `main`, with `topic` checked out. */
export function createConflictFixtures() {
    let temporary: string[] = []

    return { fixture, cleanup }

    async function fixture(format = "sha1") {
        let path = await mkdtemp(join(tmpdir(), "laneway-conflict-test-"))
        temporary.push(path)
        git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
        git(path, "config", "user.name", "Conflict Test")
        git(path, "config", "user.email", "conflict@example.invalid")
        git(path, "config", "commit.gpgsign", "false")
        await commit(path, "a.txt", "base\n", "base")
        git(path, "switch", "-qc", "topic")
        let original = await commit(path, "a.txt", "topic\n", "topic")
        await commit(path, "b.txt", "later\n", "later")
        git(path, "switch", "main")
        let base = await commit(path, "a.txt", "main\n", "new main")
        git(path, "switch", "topic")
        return { path, original, base, before: git(path, "rev-parse", "topic") }
    }

    async function cleanup() {
        for (let path of temporary.splice(0)) {
            if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
                throw new Error("Invalid fixture path")
            await rm(path, { recursive: true, force: true })
        }
    }
}

export async function commit(path: string, file: string, content: string | Buffer, message: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    git(path, "commit", "-qm", message)
    return git(path, "rev-parse", "HEAD")
}

export async function choose(path: string, subject: string, side: "left" | "right", hunk?: number) {
    let view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "choose", subject, input: view.subject.input, revision: view.candidate.revision, file: view.files[0].path, side, hunk })
}

export async function accept(path: string, subject: string) {
    let view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "accept", subject, input: view.subject.input, revision: view.candidate.revision })
}

export function transition(path: string, command: "undo" | "redo") {
    return executeOperationCommand({ command, noWait: false }, path)
}
