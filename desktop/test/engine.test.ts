import { openRepository } from "@laneway/git"
import type { EngineMessage, PublishRequest } from "@laneway/shared"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectEngine, parseEngineIdentity, parseEngineMessage, resolveEnginePath, runEngineCommand } from "../src/main/engine"
import { runPublish } from "../src/main/publish"

let enginePath = join(import.meta.dir, "../../cli/bin/lane.exe")
let directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("Laneway Engine client", () => {
    test("accepts the shipped Engine identity", () => {
        expect(parseEngineIdentity("lane 0.1.0\n")).toEqual({
            name: "lane",
            version: "0.1.0",
        })
    })

    test("rejects malformed and incompatible Engine identities", () => {
        expect(() => parseEngineIdentity("hello\n")).toThrow(
            "The selected Laneway Engine returned an invalid --version response.",
        )
        expect(() => parseEngineIdentity("lane 0.2.0\n")).toThrow(
            "Incompatible Laneway Engine version 0.2.0; expected 0.1.0.",
        )
    })

    test("resolves override, packaged, and development Engine paths", () => {
        let applicationPath = join("D:\\Apps", "Laneway.exe")
        let workspacePath = join("D:\\src", "Laneway")

        expect(resolveEnginePath({
            override: join("D:\\tools", "custom-engine.exe"),
            isPackaged: false,
            applicationPath,
            workspacePath,
        })).toBe(join("D:\\tools", "custom-engine.exe"))
        expect(resolveEnginePath({
            isPackaged: true,
            applicationPath,
            workspacePath,
        })).toBe(join("D:\\Apps", "lane.exe"))
        expect(resolveEnginePath({
            isPackaged: false,
            applicationPath,
            workspacePath,
        })).toBe(join(workspacePath, "cli", "bin", "lane.exe"))
    })

    test("inspects the selected Engine executable", async () => {
        await expect(inspectEngine(enginePath)).resolves.toEqual({
            path: enginePath,
            name: "lane",
            version: "0.1.0",
        })
    })

    test("runs one Engine process and streams validated messages", async () => {
        let received: EngineMessage[] = []
        let run = runEngineCommand({
            enginePath,
            cwd: join(import.meta.dir, "../.."),
            args: ["echo", "From desktop", "--delay-ms", "0"],
            onMessage: message => received.push(message),
        })

        let result = await run.result

        expect(result.exitCode).toBe(0)
        expect(result.diagnostics).toBe("")
        expect(result.messages).toEqual(received)
        expect(result.messages.at(-1)).toEqual({
            type: "result",
            command: "echo",
            message: "From desktop",
        })
    })

    test("rejects malformed Engine output", () => {
        expect(() => parseEngineMessage("not json")).toThrow(
            "Laneway Engine returned malformed NDJSON: not json",
        )
        expect(() => parseEngineMessage('{"type":"result","command":"other"}')).toThrow(
            'Laneway Engine returned malformed NDJSON: {"type":"result","command":"other"}',
        )
    })

    test("cancels the active Engine process cooperatively", async () => {
        let progressReceived: () => void
        let firstProgress = new Promise<void>(resolveProgress => {
            progressReceived = resolveProgress
        })
        let run = runEngineCommand({
            enginePath,
            cwd: join(import.meta.dir, "../.."),
            args: ["echo", "Cancelled", "--delay-ms", "1000"],
            onMessage: message => {
                if (message.type == "progress")
                    progressReceived()
            },
        })

        await firstProgress
        run.cancel()
        let result = await run.result

        expect(result.exitCode).toBe(3)
        expect(result.messages.at(-1)).toEqual({
            type: "cancelled",
            command: "echo",
            message: "Cancellation acknowledged.",
        })
    })
})

describe("runPublish", () => {
    test("a publish left unpublished exits with failure, and its result still comes back", async () => {
        let path = await repositoryWithoutRemote()
        let request: PublishRequest = { action: "plan", branch: "refs/heads/feature" }

        let result = await runPublish(enginePath, (await openRepository(path)).descriptor, request)

        expect(result).toMatchObject({ ok: true, result: { status: "blocked", message: "Add a remote to publish." } })
        let direct = await runEngineCommand({ enginePath, cwd: path, args: ["publish", "--request", JSON.stringify(request)] }).result
        expect(direct.exitCode).toBe(1)
    })
})

async function repositoryWithoutRemote() {
    let path = await realpath(await mkdtemp(join(tmpdir(), "laneway-publish-")))
    directories.push(path)
    let git = (...args: string[]) => {
        let result = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
    }
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Publish Test")
    git("config", "user.email", "test@example.invalid")
    git("config", "commit.gpgsign", "false")
    await writeFile(join(path, "file.txt"), "a\n")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    git("switch", "-qc", "feature")
    return path
}
