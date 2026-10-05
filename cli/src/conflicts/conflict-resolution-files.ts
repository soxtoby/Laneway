import { blob, gitText, type RepositoryGit } from "@laneway/git"
import { type ConflictFile, type ConflictSubject, type ResolutionCandidate } from "@laneway/shared"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export async function runMergeTool(repo: RepositoryGit, subject: ConflictSubject, file: ConflictFile, candidate: ResolutionCandidate) {
    if ([file.base, file.left, file.right].some(entry => entry && !entry.mode.startsWith("100")))
        throw new Error("Use a named version for symbolic-link and submodule conflicts.")
    // Git owns configured tool selection and command expansion. Only temporary copies are exposed.
    let name = (await repo.run(repo.descriptor.mainWorktree, ["config", "--get", "merge.tool"])).stdout.toString().trim()
    if (!name)
        throw new Error("Configure Git merge.tool before opening an external merge tool.")

    let directory = join(
        repo.descriptor.commonDirectory,
        "laneway",
        "resolutions",
        subject.id,
        subject.input,
        createHash("sha256").update(file.path).digest("hex"),
    )
    await mkdir(directory, { recursive: true })
    for (
        let [name, entry] of [["BASE", file.base], ["LOCAL", file.left], ["REMOTE", file.right], [
            "MERGED",
            file.path in candidate.files ? candidate.files[file.path] : file.provisional,
        ]] as const
    ) {
        let target = join(directory, name)
        // Recover saved external edits after a crash; never truncate an existing result.
        try {
            await writeFile(target, await blob(repo, entry) ?? "", { flag: name == "MERGED" ? "wx" : "w" })
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code == "EEXIST"))
                throw error
        }
    }

    let gitExec = await gitText(repo, ["--exec-path"])
    let shell = "sh"
    if (process.platform == "win32") {
        // Git for Windows exposes both cmd/git.exe and mingw64/bin/git.exe.
        let candidates = ["../bin/bash.exe", "../../bin/bash.exe"].map(path => resolve(dirname(repo.descriptor.git.path), path))
        let available = await Promise.all(candidates.map(path => lstat(path).then(stat => stat.isFile()).catch(() => false)))
        shell = candidates[available.indexOf(true)]
        if (!shell)
            throw new Error("Git Bash was not found beside the selected Git installation.")
    }

    let script = 'TOOL_MODE=merge; . "$GIT_EXEC_PATH/git-mergetool--lib"; initialize_merge_tool "$WB_TOOL" && run_merge_tool "$WB_TOOL" true'
    let processTool = Bun.spawn([shell, "-c", script], {
        cwd: repo.descriptor.mainWorktree,
        env: {
            ...process.env,
            GIT_EXEC_PATH: gitExec,
            WB_TOOL: name,
            BASE: join(directory, "BASE"),
            LOCAL: join(directory, "LOCAL"),
            REMOTE: join(directory, "REMOTE"),
            MERGED: join(directory, "MERGED"),
            BACKUP: join(directory, "BACKUP"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    })
    let [code, stderr] = await Promise.all([processTool.exited, new Response(processTool.stderr).text(), new Response(processTool.stdout).text()])
    if (code)
        throw new Error(`The merge tool did not complete successfully. Saved edits remain recoverable. ${stderr}`)

    candidate.files[file.path] = {
        mode: file.provisional?.mode ?? "100644",
        object: await gitText(repo, ["hash-object", "-w", "--stdin"], await readFile(join(directory, "MERGED"))),
    }
}

export async function cleanupResolutionFiles(repo: RepositoryGit, subject: ConflictSubject, file?: string) {
    let root = resolve(repo.descriptor.commonDirectory, "laneway", "resolutions")
    let path = resolve(root, subject.id, subject.input, ...(file ? [createHash("sha256").update(file).digest("hex")] : []))
    if (isAbsolute(relative(root, path)) || relative(root, path).startsWith(".."))
        throw new Error("Invalid resolution directory")
    await rm(path, { recursive: true, force: true })
}
