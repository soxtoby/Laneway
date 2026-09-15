import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("production conflict IPC, candidate isolation, column restart and acceptance under Electron CSP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbench-conflict-electron-"))
    const root = resolve(import.meta.dir, "../..")
    const repository = join(directory, "repository")
    const engine = join(root, "cli/bin/workbench-engine.exe")
    function git(...args: string[]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
    try {
        await mkdir(repository)
        git("init", "-q", "-b", "main")
        git("config", "user.name", "Desktop Test")
        git("config", "user.email", "test@example.invalid")
        git("config", "commit.gpgsign", "false")
        git("config", "merge.tool", "workbench-test")
        git("config", "mergetool.workbench-test.cmd", 'cat "$REMOTE" > "$MERGED"')
        git("config", "mergetool.workbench-test.trustExitCode", "true")
        await writeFile(join(repository, "file.txt"), "Order summary\nDelivery: five business days.\nTracking is included.\n")
        await writeFile(join(repository, "payment.txt"), "Payment: cash\n")
        await writeFile(join(repository, "contact.txt"), "Support: email\n")
        git("add", ".")
        git("commit", "-qm", "base")
        git("switch", "-qc", "topic")
        await writeFile(join(repository, "file.txt"), "Order summary\nDelivery: next business day.\nTracking is included.\n")
        await writeFile(join(repository, "payment.txt"), "Payment: card\n")
        await writeFile(join(repository, "contact.txt"), "Support: live chat\n")
        git("commit", "-qam", "topic change")
        await writeFile(join(repository, "receipt.txt"), "A clean descendant\n")
        git("add", ".")
        git("commit", "-qm", "clean descendant")
        git("switch", "main")
        await writeFile(join(repository, "file.txt"), "Order summary\nDelivery: three business days.\nTracking is included.\n")
        await writeFile(join(repository, "payment.txt"), "Payment: bank transfer\n")
        await writeFile(join(repository, "contact.txt"), "Support: phone\n")
        git("commit", "-qam", "base change")
        const base = git("rev-parse", "HEAD")
        git("switch", "topic")
        const rewrite = Bun.spawn([
            engine,
            "conflict",
            "--json",
            "--request",
            JSON.stringify({ action: "rewrite", branches: ["topic"], base, path: repository }),
        ], { cwd: repository, stdout: "pipe", stderr: "pipe" })
        const [output, code] = await Promise.all([new Response(rewrite.stdout).text(), rewrite.exited])
        expect(code, output).toBe(0)
        await writeFile(
            join(directory, "workspace.json"),
            JSON.stringify({
                version: 1,
                activeRepositoryId: "fixture",
                repositories: [{ id: "fixture", path: repository, name: "repository", anchors: [], open: true, columns: [], layoutInitialized: false }],
            }),
        )
        const build = Bun.spawn([process.execPath, "run", "--cwd", "desktop", "build"], { cwd: root, stdout: "ignore", stderr: "pipe" })
        const diagnostics = await new Response(build.stderr).text()
        expect(await build.exited, diagnostics).toBe(0)
        for (const phase of ["unresolved", "candidate", "accept"]) {
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                WORKBENCH_ENGINE_PATH: engine,
                WORKBENCH_SETTINGS_PATH: join(directory, "settings.json"),
                WORKBENCH_WORKSPACE_PATH: join(directory, "workspace.json"),
            }
            delete env.ELECTRON_RUN_AS_NODE
            let errors = ""
            const exitCode = await new Promise<number | null>((done, reject) => {
                const child = spawn(electron as unknown as string, [
                    join(import.meta.dir, "fixtures/conflict-electron.cjs"),
                    directory,
                    join(root, "desktop/out/main/index.js"),
                    phase,
                ], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], timeout: 100_000 })
                child.stderr.on("data", chunk => errors += String(chunk))
                child.on("error", reject)
                child.on("close", done)
            })
            const result = await readFile(join(directory, `${phase}.json`), "utf8").catch(() => errors)
            expect(exitCode, result).toBe(0)
            if (phase != "accept") {
                expect(await readFile(join(repository, "file.txt"), "utf8")).toContain("<<<<<<<")
                await mkdir(join(root, "desktop/out/validation"), { recursive: true })
                await copyFile(join(directory, `${phase}.png`), join(root, `desktop/out/validation/conflict-${phase}.png`))
                await copyFile(join(directory, `${phase}-dark.png`), join(root, `desktop/out/validation/conflict-${phase}-dark.png`))
            }
        }
        expect(git("branch", "--show-current")).toBe("topic")
        expect(git("show", "HEAD:file.txt")).toBe("Order summary\nDelivery: next business day.\nTracking is included.")
        expect(git("show", "HEAD:payment.txt")).toBe("Payment: bank transfer")
        expect(git("show", "HEAD:contact.txt")).toBe("Support: live chat")
        expect(git("status", "--porcelain")).toBe("")
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
}, 240_000)
