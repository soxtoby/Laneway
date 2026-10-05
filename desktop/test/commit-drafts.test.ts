import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { CommitDrafts } from "../src/main/commit-drafts"

test("drafts serialize edits, survive restart, and isolate worktrees", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-drafts-"))
    try {
        let path = join(directory, "drafts.json")
        let store = new CommitDrafts(path)
        await Promise.all([
            store.write("repo", "a", { title: "First", message: "", branch: "topic" }),
            store.write("repo", "a", { title: "Latest", message: "Details", branch: "topic" }),
            store.write("repo", "b", { title: "Other", message: "", branch: "other" }),
        ])

        let restarted = new CommitDrafts(path)
        expect((await restarted.read("repo", "a")).title).toBe("Latest")
        expect((await restarted.read("repo", "b")).title).toBe("Other")

        await restarted.write("repo", "a", { title: "", message: "", branch: "" })
        expect((await new CommitDrafts(path).read("repo", "a")).title).toBe("")
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
})
