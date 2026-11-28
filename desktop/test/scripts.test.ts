import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileCommand, runScript, terminalLaunch, variableIn } from "../src/main/scripts"

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

// A name the shell would read as commands if it ever saw it as part of one: each makes a `canary` directory.
let hostile = process.platform == "win32"
    ? "a b &mkdir canary& (x) %NOPE% 100% ^ !&mkdir canary&.txt"
    : "a b; mkdir canary; $(mkdir canary) `mkdir canary` 'q' \"d\" & mkdir canary &.txt"
let print = process.platform == "win32" ? "type" : "cat"
// The shell macOS and Linux run scripts in; Windows has one where Git brings it.
let gitShell = "C:/Program Files/Git/usr/bin/sh.exe"
let sh = Bun.which("sh") ?? (existsSync(gitShell) ? gitShell : undefined)

describe("File Scripts", () => {
    test("a file script runs on its file by a name the shell reads none of, wherever the command puts it", async () => {
        let directory = await temporaryDirectory()
        await writeFile(resolve(directory, hostile), "the file")
        let command = `${print} {file} > bare.txt && ${print} "{file}" > quoted.txt && echo line[ {line}] > line.txt`

        let result = await runScript({ id: "copy", name: "Copy", command, target: "file" }, directory, { path: hostile, line: 7 })

        expect(result).toEqual({ ok: true })
        expect(await readFile(resolve(directory, "bare.txt"), "utf8")).toBe("the file")
        expect(await readFile(resolve(directory, "quoted.txt"), "utf8")).toBe("the file")
        expect((await readFile(resolve(directory, "line.txt"), "utf8")).trim()).toBe("line 7")
        expect((await readdir(directory)).sort()).toEqual([hostile, "bare.txt", "line.txt", "quoted.txt"].sort())
    })

    // An editor's command on Windows is often a batch file, such as `code.cmd`, which reads the arguments it passes on a second time.
    test.skipIf(process.platform != "win32")("a file script's file reaches a batch file's program as one argument, with nothing in its name run", async () => {
        let directory = await temporaryDirectory()
        await writeFile(resolve(directory, hostile), "the file")
        await writeFile(resolve(directory, "read.cmd"), "@echo off\r\ntype %* > read.txt\r\n")
        await writeFile(resolve(directory, "arguments.cmd"), "@echo off\r\necho %* > arguments.txt\r\n")

        let read = await runScript({ id: "read", name: "Read", command: ".\\read.cmd {file}", target: "file" }, directory, { path: hostile })
        let passed = await runScript({ id: "pass", name: "Pass", command: ".\\arguments.cmd --goto {file}:{line}", target: "file" }, directory, {
            path: hostile,
            line: 7,
        })

        expect([read, passed]).toEqual([{ ok: true }, { ok: true }])
        expect(await readFile(resolve(directory, "read.txt"), "utf8")).toBe("the file")
        expect((await readFile(resolve(directory, "arguments.txt"), "utf8")).trim()).toBe(`--goto "${resolve(directory, hostile)}":7`)
        expect((await readdir(directory)).sort()).toEqual([hostile, "arguments.cmd", "arguments.txt", "read.cmd", "read.txt"].sort())
    })

    test("a file script with no line chosen leaves out the part that names it, and takes its file last without a place for it", async () => {
        let directory = await temporaryDirectory()
        await writeFile(resolve(directory, "notes.txt"), "the notes")
        let command = `echo line[ {line}] > line.txt && ${process.platform == "win32" ? "del" : "rm"}`

        let result = await runScript({ id: "remove", name: "Remove", command, target: "file" }, directory, { path: "notes.txt" })

        expect(result).toEqual({ ok: true })
        expect((await readFile(resolve(directory, "line.txt"), "utf8")).trim()).toBe("line")
        expect(await readdir(directory)).toEqual(["line.txt"])
    })

    test("a file script runs on a file whose name, or whose folder's, starts with dots", async () => {
        let directory = await temporaryDirectory()
        await mkdir(resolve(directory, "...drafts"))
        await writeFile(resolve(directory, "..notes.txt"), "the notes")
        await writeFile(resolve(directory, "...drafts", "plan.txt"), "the plan")
        let script = { id: "read", name: "Read", command: `${print} {file} >> read.txt`, target: "file" as const }

        let results = [await runScript(script, directory, { path: "..notes.txt" }), await runScript(script, directory, { path: "...drafts/plan.txt" })]

        expect(results).toEqual([{ ok: true }, { ok: true }])
        expect(await readFile(resolve(directory, "read.txt"), "utf8")).toBe("the notesthe plan")
    })

    test("a file script fails without running when its file is gone, a folder, outside the worktree, or not given", async () => {
        let directory = await temporaryDirectory()
        let outside = await temporaryDirectory()
        await writeFile(resolve(outside, "secret.txt"), "elsewhere")
        await mkdir(resolve(directory, "library"))
        let script = { id: "mark", name: "Mark", command: "echo ran on {file}> ran.txt", target: "file" as const }

        let gone = await runScript(script, directory, { path: "removed.txt" })
        let folder = await runScript(script, directory, { path: "library" })
        let escaped = await runScript(script, directory, { path: resolve(outside, "secret.txt") })
        let climbed = await runScript(script, directory, { path: "../secret.txt" })
        let missing = await runScript(script, directory)

        expect(gone).toEqual({ ok: false, message: `removed.txt is not in ${directory}.` })
        expect(folder).toEqual({ ok: false, message: "library is not a file." })
        expect(escaped.ok).toBe(false)
        expect(climbed.ok).toBe(false)
        expect(missing).toEqual({ ok: false, message: "It runs on a file, and none was chosen." })
        expect(await readdir(directory)).toEqual(["library"])
    })

    // Past a pipe, in `for /f`, after `call`, and for a batch file, `cmd` reads the line again with the path in it.
    test.skipIf(process.platform != "win32")("a file script won't run on a file whose name Windows' shell could read a variable from", async () => {
        let directory = await temporaryDirectory()
        // Percent signs that name no variable stay as they are on a second reading, whatever else the name holds.
        let plain = "100% a%20b%20c %&mkdir canary&%.txt"
        await writeFile(resolve(directory, "%OS%.txt"), "the file")
        await writeFile(resolve(directory, plain), "the file")
        let script = { id: "read", name: "Read", command: "type {file} | findstr . > read.txt", target: "file" as const }

        let refused = await runScript(script, directory, { path: "%OS%.txt" })
        let entries = await readdir(directory)
        let ran = await runScript(script, directory, { path: plain })

        expect(refused).toEqual({ ok: false, message: "%OS%.txt has %OS% in its name, which the shell could read as that variable." })
        expect(entries).not.toContain("read.txt")
        expect(ran).toEqual({ ok: true })
        expect((await readFile(resolve(directory, "read.txt"), "utf8")).trim()).toBe("the file")
        expect((await readdir(directory)).sort()).toEqual(["%OS%.txt", plain, "read.txt"].sort())
    })

    test("a path names a variable Windows' shell would read where one stands between two of its percent signs", () => {
        let environment = { LANEWAY_FILE: "D:\\Source\\a.ts", Path: "C:\\Windows" }
        let named = ["%path%.txt", "x%CMDCMDLINE%&y.txt", "%=ExitCode%.txt", "a%b%LANEWAY_FILE%.txt"]
        let plain = ["100%.txt", "a%20b%20c.txt", "%nope%.txt", "%%.txt"]

        expect(named.map(path => variableIn(path, environment))).toEqual(["path", "CMDCMDLINE", "=ExitCode", "LANEWAY_FILE"])
        expect(plain.filter(path => variableIn(path, environment) != undefined)).toEqual([])
    })

    test("Windows reads a file's path from the environment, inside the command's quotes or its own", () => {
        let path = "D:\\Source\\a & b.ts"

        expect(fileCommand("code --goto {file}:{line}", { path, line: 12 }, "win32")).toEqual({
            command: `code --goto "%LANEWAY_FILE%":12`,
            environment: { LANEWAY_FILE: path },
        })
        expect(fileCommand(`code "{file}"[ --line {line}]`, { path }, "win32").command).toBe(`code "%LANEWAY_FILE%"`)
        // A caret's quote opens nothing, so the path still gets quotes of its own.
        expect(fileCommand(`echo ^" {file}`, { path }, "win32").command).toBe(`echo ^" "%LANEWAY_FILE%"`)
        expect(fileCommand("notepad", { path }, "win32").command).toBe(`notepad "%LANEWAY_FILE%"`)
        expect(fileCommand("rider --line {line} {file}", { path }, "win32").command).toBe(`rider --line 1 "%LANEWAY_FILE%"`)
    })

    test("other shells read a file's path from the environment too, quoted for where the command puts it", () => {
        let path = "/source/it's $(here).ts"

        expect(fileCommand("code --goto {file}:{line}", { path, line: 3 }, "linux")).toEqual({
            command: `code --goto "$LANEWAY_FILE":3`,
            environment: { LANEWAY_FILE: path },
        })
        // The command's own quotes close around the variable's.
        expect(fileCommand(`echo 'in {file}' "{file}" \\" {file}`, { path }, "linux").command).toBe(
            `echo 'in '"$LANEWAY_FILE"'' """$LANEWAY_FILE""" \\" "$LANEWAY_FILE"`,
        )
        // A command substitution starts quoting afresh, whatever quotes it is inside.
        expect(fileCommand('cd "$(dirname {file})" && ls "$(basename "{file}")" "`echo {file}`"', { path }, "linux").command).toBe(
            'cd "$(dirname "$LANEWAY_FILE")" && ls "$(basename """$LANEWAY_FILE""")" "`echo "$LANEWAY_FILE"`"',
        )
    })

    test.skipIf(!sh)("another shell's file script reads its file as one argument, in quotes and command substitutions, with nothing in its name run", () => {
        let directory = mkdtempSync(resolve(tmpdir(), "laneway-scripts-"))
        temporaryDirectories.push(directory)
        let name = "a b; mkdir canary; $(mkdir canary) `mkdir canary` 'q' & mkdir canary &.txt"
        writeFileSync(resolve(directory, name), "the file")
        let commands = [
            "cat {file}",
            `cat "{file}"`,
            "cat '{file}'",
            `echo "$(cat {file})"`,
            `echo "$(cat "{file}")"`,
            'echo "`cat {file}`"',
            `cd "$(dirname {file})" && cat "$(basename {file})"`,
            // A shell the command starts itself reads the path where the command names the variable.
            `sh -c 'cat "$LANEWAY_FILE"'`,
        ]

        let read = commands.map(command => {
            let expanded = fileCommand(command, { path: resolve(directory, name).replaceAll("\\", "/") }, "linux")
            let ran = spawnSync(sh!, ["-c", expanded.command], { cwd: directory, env: { ...process.env, ...expanded.environment }, encoding: "utf8" })
            return ran.stdout.trim()
        })

        expect(read).toEqual(commands.map(() => "the file"))
        expect(readdirSync(directory)).toEqual([name])
    })

    test("macOS's Terminal exports a file script's environment ahead of its command", () => {
        let launch = terminalLaunch('code "$LANEWAY_FILE"', "Editor", "/source", { LANEWAY_FILE: "/source/it's.ts" }, "darwin")

        expect(launch.args.slice(-2)).toEqual(["/source", `export LANEWAY_FILE='/source/it'\\''s.ts' && code "$LANEWAY_FILE"`])
    })
})

async function temporaryDirectory() {
    let path = await mkdtemp(resolve(tmpdir(), "laneway-scripts-"))
    temporaryDirectories.push(path)
    return path
}
