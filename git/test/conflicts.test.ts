import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { candidateReady, conflictHunks, connectRepository, hasConflictMarkers, replayTree, treeEntries, withConflictScratch } from "../src/index"

test.each([["Updated stack at abcdef12 (record-1)", "Replayed commit fedcba98 (record-1)"], [
    "Before this commit at abcdef12 (record-1)",
    "This commit fedcba98 (record-1)",
], ["Current files before restoring stash at abcdef12 (record-1)", "Stashed changes fedcba98 (record-1)"]])(
    "recorded markers remain unresolved across label versions: %s",
    (leftLabel, rightLabel) => {
        let subject = { id: "record-1", input: "a".repeat(40), tree: "b".repeat(40), leftLabel, rightLabel, markerSize: 8, files: [] }
        let start = `<<<<<<<< ${leftLabel}`, end = `>>>>>>>> ${rightLabel}`
        let marked = `${start}\nleft\n========\nright\n${end}\n`

        expect(conflictHunks(marked, subject)).toHaveLength(1)
        expect(hasConflictMarkers(marked, subject)).toBe(true)

        // A partly removed marker must still prevent acceptance, including CRLF files.
        expect(hasConflictMarkers(`${start}\r\nleft\r\n`, subject)).toBe(true)
        expect(hasConflictMarkers(`right\r\n${end}\r\n`, subject)).toBe(true)
        expect(hasConflictMarkers(marked.replaceAll("record-1", "record-2"), subject)).toBe(false)
        expect(hasConflictMarkers("left\nright\n", subject)).toBe(false)
    },
)

test("binary, delete/modify and file/directory conflicts retain exact sources without sibling artifacts", async () => {
    await withConflictScratch(async path => {
        git("init", "-qb", "main")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@example.invalid")
        git("config", "commit.gpgsign", "false")
        await writeFile(join(path, "binary"), Buffer.from([0, 1]))
        await writeFile(join(path, "deleted"), "base\n")
        git("add", ".")
        git("commit", "-qm", "base")
        let base = git("rev-parse", "HEAD")

        git("switch", "-qc", "left")
        await writeFile(join(path, "binary"), Buffer.from([0, 2]))
        await writeFile(join(path, "collision"), "file\n")
        git("rm", "deleted")
        git("add", ".")
        git("commit", "-qm", "left")
        let left = git("rev-parse", "HEAD")

        git("switch", "-qc", "right", base)
        await writeFile(join(path, "binary"), Buffer.from([0, 3]))
        await writeFile(join(path, "deleted"), "right\n")
        await mkdir(join(path, "collision"))
        await writeFile(join(path, "collision/child"), "child\n")
        git("add", ".")
        git("commit", "-qm", "right")

        let repo = await connectRepository(path)
        let result = await replayTree(repo, base, left, git("rev-parse", "HEAD"), "structural")
        let files = await treeEntries(repo, result.tree)

        expect([...files.keys()].sort()).toEqual(["binary", "collision/child", "deleted"])
        expect(result.conflict!.files.find(file => file.path == "binary")!.text).toBe(false)
        expect(result.conflict!.files.find(file => file.path == "deleted")!.left).toBeNull()
        expect(result.conflict!.files.some(file => file.path == "collision")).toBe(true)
        expect(await candidateReady(repo, result.conflict!, { subject: "structural", input: result.conflict!.input, revision: "", files: {} })).toBe(false)
        expect(git("ls-files", "--unmerged")).toBe("")

        function git(...args: string[]) {
            let result = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" })
            if (result.exitCode)
                throw new Error(result.stderr.toString())
            return result.stdout.toString().trim()
        }
    })
}, 60000)
