import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("production conflict IPC, candidate isolation, column restart and acceptance under Electron CSP", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-conflict-electron-"))
    let root = resolve(import.meta.dir, "../..")
    let repository = join(directory, "repository")
    let engine = join(root, "cli/bin/lane.exe")
    try {
        await mkdir(repository)
        git("init", "-q", "-b", "main")
        git("config", "user.name", "Desktop Test")
        git("config", "user.email", "test@example.invalid")
        git("config", "commit.gpgsign", "false")
        git("config", "merge.tool", "laneway-test")
        git("config", "mergetool.laneway-test.cmd", 'cat "$REMOTE" > "$MERGED"')
        git("config", "mergetool.laneway-test.trustExitCode", "true")
        await writeFile(join(repository, "file.txt"), "Order summary\nDelivery: five business days.\nTracking is included.\n")
        await writeFile(join(repository, "payment.txt"), "Payment: cash\n")
        await writeFile(join(repository, "contact.ts"), 'export const support = "email"\n')
        git("add", ".")
        git("commit", "-qm", "base")
        git("switch", "-qc", "topic")
        await writeFile(join(repository, "file.txt"), "Order summary\nDelivery: next business day.\nTracking is included.\n")
        await writeFile(join(repository, "payment.txt"), "Payment: card\n")
        await writeFile(join(repository, "contact.ts"), 'export const support = "live chat"\n')
        await writeFile(join(repository, "notes.txt"), "A clean file in the conflicted commit\n")
        git("add", ".")
        git("commit", "-qam", "topic change")
        git("branch", "lower")
        await writeFile(join(repository, "receipt.txt"), "A clean descendant\n")
        git("add", ".")
        git("commit", "-qm", "clean descendant")
        git("switch", "main")
        await writeFile(join(repository, "file.txt"), "Order summary\nDelivery: three business days.\nTracking is included.\n")
        await writeFile(join(repository, "payment.txt"), "Payment: bank transfer\n")
        await writeFile(join(repository, "contact.ts"), 'export const support = "phone"\n')
        git("commit", "-qam", "base change")
        let base = git("rev-parse", "HEAD")
        git("switch", "topic")
        let rewrite = Bun.spawn([
            engine,
            "conflict",
            "--json",
            "--request",
            JSON.stringify({ action: "rewrite", branches: ["lower", "topic"], base, path: repository }),
        ], { cwd: repository, stdout: "pipe", stderr: "pipe" })
        let [output, code] = await Promise.all([new Response(rewrite.stdout).text(), rewrite.exited])
        expect(code, output).toBe(0)
        await writeFile(
            join(directory, "workspace.json"),
            JSON.stringify({
                version: 1,
                activeRepositoryId: "fixture",
                repositories: [{ id: "fixture", path: repository, name: "repository", anchors: [], open: true, columns: [], layoutInitialized: false }],
            }),
        )
        // The test script builds desktop/out once; parallel test files must not rebuild it.
        for (let phase of ["unresolved", "candidate", "accept"]) {
            let env: NodeJS.ProcessEnv = {
                ...process.env,
                LANEWAY_ENGINE_PATH: engine,
                LANEWAY_SETTINGS_PATH: join(directory, "settings.json"),
                LANEWAY_WORKSPACE_PATH: join(directory, "workspace.json"),
            }
            delete env.ELECTRON_RUN_AS_NODE
            let errors = ""
            let exitCode = await new Promise<number | null>((done, reject) => {
                let child = spawn(electron as unknown as string, [
                    join(import.meta.dir, "fixtures/conflict-electron.cjs"),
                    directory,
                    join(root, "desktop/out/main/index.js"),
                    phase,
                ], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], timeout: 100_000 })
                child.stderr.on("data", chunk => errors += String(chunk))
                child.on("error", reject)
                child.on("close", done)
            })
            let result = await readFile(join(directory, `${phase}.json`), "utf8").catch(() => errors)
            expect(exitCode, result).toBe(0)
            if (phase != "accept") {
                let marked = await readFile(join(repository, "file.txt"), "utf8")
                expect(marked).toContain("<<<<<<< Before this commit at")
                expect(marked).toContain(">>>>>>> This commit")
                await mkdir(join(root, "desktop/out/validation"), { recursive: true })
                await copyFile(join(directory, `${phase}.png`), join(root, `desktop/out/validation/conflict-${phase}.png`))
                await copyFile(join(directory, `${phase}-dark.png`), join(root, `desktop/out/validation/conflict-${phase}-dark.png`))
            }
        }
        expect(git("branch", "--show-current")).toBe("topic")
        expect(git("show", "HEAD:file.txt")).toBe("Order summary\nDelivery: next business day.\nTracking is included.")
        expect(git("show", "HEAD:payment.txt")).toBe("Payment: bank transfer")
        expect(git("show", "HEAD:contact.ts")).toBe('export const support = "live chat"')
        expect(git("status", "--porcelain")).toBe("")
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
    function git(...args: string[]) {
        let result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
}, 240_000)
