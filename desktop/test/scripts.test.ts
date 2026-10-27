import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { runScript } from "../src/main/scripts"

let temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Repository Scripts", () => {
    test("a script without a terminal runs as typed in the worktree's directory and reports success", async () => {
        let directory = await temporaryDirectory()

        let result = await runScript({ id: "build", name: "Build", command: "echo built> first.txt && echo again> second.txt" }, directory)

        expect(result).toEqual({ ok: true })
        expect((await readFile(resolve(directory, "first.txt"), "utf8")).trim()).toBe("built")
        expect((await readFile(resolve(directory, "second.txt"), "utf8")).trim()).toBe("again")
    })

    test("a failing script reports its exit code and the end of its output", async () => {
        let directory = await temporaryDirectory()

        let result = await runScript({ id: "test", name: "Test", command: "echo checking && echo broken 1>&2 && exit 3" }, directory)

        expect(result).toMatchObject({ ok: false, message: "It exited with code 3." })
        expect(result.ok == false && result.output).toBe("checking\nbroken")
    })

    test("a script whose worktree directory is gone fails without running", async () => {
        let directory = resolve(await temporaryDirectory(), "removed")

        let result = await runScript({ id: "build", name: "Build", command: "echo built> first.txt" }, directory)

        expect(result).toEqual({ ok: false, message: `${directory} is no longer a directory.` })
    })
})

async function temporaryDirectory() {
    let path = await mkdtemp(resolve(tmpdir(), "laneway-scripts-"))
    temporaryDirectories.push(path)
    return path
}
