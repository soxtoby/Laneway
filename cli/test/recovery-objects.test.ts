import { connectRepository } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { copyFile, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { migrateRecoveryRefs, releaseRecoveryObjects, retainRecoveryObjects } from "../src/operations/recovery-objects"

let temporary: string[] = []
afterEach(async () => {
    for (let path of temporary.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

for (let format of ["sha1", "sha256"]) {
    test(`recovery does not depend on another tool's pack protection (${format})`, async () => {
        let { path, git, repo } = await fixture(format)
        let object = await repo.hashObject("private snapshot")
        let command = repo.command.bind(repo)
        let directory = join(path, ".git", "objects", "pack")
        let foreign: string | undefined
        repo.command = async (...args) => {
            let output = await command(...args)
            if (args[1].includes("pack-objects") && !foreign) {
                foreign = output.toString().trim()
                for (let extension of ["pack", "idx"])
                    await copyFile(`${args[1].at(-1)}-${foreign}.${extension}`, join(directory, `pack-${foreign}.${extension}`))
                await writeFile(join(directory, `pack-${foreign}.keep`), "Another tool\n")
            }
            return output
        }
        await retainRecoveryObjects(repo, "snapshot", [object])

        expect(await readFile(join(directory, `pack-${foreign}.keep`), "utf8")).toBe("Another tool\n")

        await unlink(join(directory, `pack-${foreign}.keep`))
        git("gc", "--prune=now")

        expect(git("cat-file", "blob", object)).toBe("private snapshot")
    }, 30_000)

    test(`existing packs are reused rather than copying the repository's history (${format})`, async () => {
        let { path, git, keeps } = await fixture(format)
        git("gc", "--prune=now")
        let directory = join(path, ".git", "objects", "pack")
        let repo = await connectRepository(path)
        // Existing packs must not count toward the recovery consolidation threshold.
        for (let i = 0; i < 33; i++) {
            let object = await repo.hashObject(`existing packed object ${i}`)
            await repo.command(path, ["pack-objects", join(directory, "pack")], `${object}\n`)
        }
        let before = (await readdir(directory)).filter(file => file.endsWith(".pack"))
        await releaseRecoveryObjects(repo, "missing")

        expect(await keeps()).toHaveLength(0)

        await retainRecoveryObjects(repo, "existing", [git("rev-parse", "HEAD")])

        expect((await readdir(directory)).filter(file => file.endsWith(".pack"))).toEqual(before)
        expect(await keeps()).toHaveLength(before.length)

        await retainRecoveryObjects(repo, "shared", [git("rev-parse", "HEAD")])
        await releaseRecoveryObjects(await connectRepository(path), "shared")

        expect((await readdir(directory)).filter(file => file.endsWith(".pack"))).toEqual(before)
        expect(await keeps()).toHaveLength(before.length)

        git("gc", "--prune=now")

        expect(git("show", "HEAD:file")).toBe("original")

        await releaseRecoveryObjects(await connectRepository(path), "existing")

        expect(await keeps()).toHaveLength(0)
    }, 30_000)

    test(`recovery packs share objects, survive pruning, and release abandoned state (${format})`, async () => {
        let { path, git, repo, keeps } = await fixture(format)
        let head = git("rev-parse", "HEAD")
        let first = await repo.hashObject("first private snapshot")
        let second = await repo.hashObject("second private snapshot")
        await retainRecoveryObjects(repo, "first", [head, first])
        await retainRecoveryObjects(repo, "same", [head, first])

        expect(await keeps()).toHaveLength(1)

        await retainRecoveryObjects(repo, "second", [head, second])

        expect(await keeps()).toHaveLength(2)

        git("reflog", "expire", "--expire=now", "--all")
        git("gc", "--prune=now")

        expect(git("cat-file", "blob", first)).toBe("first private snapshot")
        expect(git("cat-file", "blob", second)).toBe("second private snapshot")
        expect(git("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main")

        await releaseRecoveryObjects(await connectRepository(path), "first")
        await releaseRecoveryObjects(await connectRepository(path), "same")
        git("gc", "--prune=now")

        expect(git("cat-file", "blob", second)).toBe("second private snapshot")
        // Shared packs are collected at consolidation or when the pool empties.
        expect(await keeps()).toHaveLength(2)

        await releaseRecoveryObjects(await connectRepository(path), "second")

        expect(await keeps()).toHaveLength(0)

        git("gc", "--prune=now")

        expect(() => git("cat-file", "blob", first)).toThrow()
        expect(() => git("cat-file", "blob", second)).toThrow()
    }, 30_000)

    test(`legacy recovery refs migrate atomically without losing orphaned history (${format})`, async () => {
        let { path, git, repo } = await fixture(format)
        await writeFile(join(path, "file"), "retained only by recovery\n")
        git("add", ".")
        git("commit", "-qm", "Old head")
        let orphan = git("rev-parse", "HEAD")
        git("update-ref", "refs/laneway/recovery/legacy/before/0", orphan)
        git("update-ref", "refs/laneway/recovery/legacy/before/state-0", orphan)
        git("reset", "--hard", "HEAD^")
        await migrateRecoveryRefs(repo)

        expect(git("for-each-ref", "--format=%(refname)", "refs/laneway/recovery")).toBe("")

        git("reflog", "expire", "--expire=now", "--all")
        git("gc", "--prune=now")

        expect(git("show", `${orphan}:file`)).toBe("retained only by recovery")

        git("fsck", "--no-reflogs")
        let manifest = JSON.parse(await readFile(join(path, ".git", "laneway", "recovery-objects.json"), "utf8"))

        expect(JSON.parse(manifest.data).operations.legacy).toEqual([orphan])
    }, 30_000)
}

async function fixture(format: string) {
    let path = await mkdtemp(join(tmpdir(), "laneway-retention-"))
    temporary.push(path)
    let git = (...args: string[]) => {
        let result = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
    git("init", "-q", "-b", "main", `--object-format=${format}`)
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.invalid")
    git("config", "commit.gpgsign", "false")
    await writeFile(join(path, "file"), "original\n")
    git("add", ".")
    git("commit", "-qm", "Original")
    let repo = await connectRepository(path)
    let keeps = async () => (await readdir(join(path, ".git", "objects", "pack"))).filter(file => file.endsWith(".keep"))
    return { path, git, repo, keeps }
}
