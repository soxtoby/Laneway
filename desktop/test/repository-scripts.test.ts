import { parseWorkspacePresentation } from "@laneway/settings"
import type { RepositoryScript, Workspace } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import type { Notice } from "../src/renderer/react/notice"
import { createRepositoryScripts } from "../src/renderer/react/repository-scripts"
import { fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let editor: RepositoryScript = { id: "editor", name: "Editor", command: "code ." }
let terminal: RepositoryScript = { id: "terminal", name: "Terminal", command: "wt -d ." }
let build: RepositoryScript = { id: "build", name: "Build", command: "bun run build" }
let code: RepositoryScript = { id: "code", name: "Code", command: "code --goto {file}[:{line}]", target: "file" }
let lint: RepositoryScript = { id: "lint", name: "Lint", command: "eslint {file}", target: "file" }

describe("Repository Scripts for every repository", () => {
    test("deleting one stops every repository's script button repeating it, and Undo has them repeat it again", () => {
        let scenario = scriptsScenario({ scripts: [editor, terminal] }, [{ lastScriptId: "editor" }, { lastScriptId: "editor" }, {
            scripts: [build],
            lastScriptId: "build",
        }])

        scenario.scripts.edit(scenario.ids[0], "editor")
        scenario.scripts.delete()

        expect(scenario.workspace().scripts).toEqual([terminal])
        expect(scenario.lastScripts()).toEqual([undefined, undefined, "build"])

        scenario.notices.at(-1)!.action!.run()

        expect(scenario.workspace().scripts).toEqual([editor, terminal])
        expect(scenario.lastScripts()).toEqual(["editor", "editor", "build"])
    })

    test("Undo leaves a script button on another script it ran since the deletion", () => {
        let scenario = scriptsScenario({ scripts: [editor, terminal] }, [{ lastScriptId: "editor" }, { lastScriptId: "editor" }])
        scenario.scripts.edit(scenario.ids[0], "editor")
        scenario.scripts.delete()
        void scenario.scripts.run(scenario.ids[1], "D:\\Source\\second", "terminal")

        scenario.notices.at(-1)!.action!.run()

        expect(scenario.lastScripts()).toEqual(["editor", "terminal"])
    })

    test("Undo brings one back after the repository whose menu deleted it has closed", () => {
        let scenario = scriptsScenario({ scripts: [editor, terminal] }, [{}, { lastScriptId: "editor" }])
        scenario.scripts.edit(scenario.ids[0], "editor")
        scenario.scripts.delete()
        scenario.close(scenario.ids[0])

        scenario.notices.at(-1)!.action!.run()

        expect(scenario.workspace().scripts).toEqual([editor, terminal])
        expect(scenario.lastScripts()).toEqual(["editor"])
    })

    test("changing one keeps its place among them, and every repository's script button on it", () => {
        let scenario = scriptsScenario({ scripts: [editor, terminal] }, [{ scripts: [build], lastScriptId: "editor" }, { lastScriptId: "editor" }])

        scenario.scripts.edit(scenario.ids[1], "editor")
        scenario.scripts.setCommand("code --new-window .")
        scenario.scripts.save()

        expect(scenario.workspace().scripts).toEqual([{ ...editor, command: "code --new-window ." }, terminal])
        expect(scenario.workspace().repositories.map(repository => repository.scripts)).toEqual([[build], undefined])
        expect(scenario.lastScripts()).toEqual(["editor", "editor"])
    })

    test("saving one for a single repository moves it last among that repository's own, and the others stop repeating it", () => {
        let scenario = scriptsScenario({ scripts: [editor, terminal] }, [{ scripts: [build], lastScriptId: "editor" }, { lastScriptId: "editor" }])

        scenario.scripts.edit(scenario.ids[0], "editor")
        scenario.scripts.setGlobal(false)
        scenario.scripts.save()

        let moved = scenario.workspace().repositories[0].scripts!.at(-1)!
        expect(scenario.workspace().scripts).toEqual([terminal])
        expect(scenario.workspace().repositories.map(repository => repository.scripts)).toEqual([[build, { ...editor, id: moved.id }], undefined])
        expect(scenario.lastScripts()).toEqual([moved.id, undefined])
    })

    test("saving a repository's own for every repository moves it last among theirs, where another repository runs it", async () => {
        let scenario = scriptsScenario({ scripts: [terminal] }, [{ scripts: [build, editor], lastScriptId: "build" }, {}])

        scenario.scripts.edit(scenario.ids[0], "build")
        scenario.scripts.setGlobal(true)
        scenario.scripts.save()
        let moved = scenario.workspace().scripts!.at(-1)!
        await scenario.scripts.run(scenario.ids[1], "D:\\Source\\second", moved.id)

        expect(scenario.workspace().scripts).toEqual([terminal, { ...build, id: moved.id }])
        expect(scenario.workspace().repositories.map(repository => repository.scripts)).toEqual([[editor], undefined])
        expect(scenario.lastScripts()).toEqual([moved.id, moved.id])
        expect(scenario.runs).toEqual([[scenario.ids[1], "D:\\Source\\second", moved.id]])
    })

    test("saving a repository's own for every repository leaves another repository's script with its id alone, in a workspace that saves", () => {
        let other: RepositoryScript = { ...build, command: "make" }
        let scenario = scriptsScenario({}, [{ scripts: [build], lastScriptId: "build" }, { scripts: [other], lastScriptId: "build" }])

        scenario.scripts.edit(scenario.ids[0], "build")
        scenario.scripts.setGlobal(true)
        scenario.scripts.save()

        let [moved] = scenario.workspace().scripts!
        expect(scenario.workspace().repositories[1]).toMatchObject({ scripts: [other], lastScriptId: "build" })
        expect(scenario.lastScripts()[0]).toBe(moved.id)
        expect(() => parseWorkspacePresentation(scenario.workspace())).not.toThrow()
    })
})

describe("File Scripts", () => {
    test("running one on a file takes the file and the line chosen, and has the repository's file buttons repeat it, not its script buttons", async () => {
        let scenario = scriptsScenario({ scripts: [editor, code] }, [{ scripts: [lint], lastScriptId: "editor" }, {}])

        await scenario.scripts.runOnFile(scenario.ids[0], "D:\\Source\\first", "code", { path: "src/a.ts", line: 12 })
        await scenario.scripts.runOnFile(scenario.ids[0], "D:\\Source\\first", "lint", { path: "src/a.ts" })

        expect(scenario.runs).toEqual([[scenario.ids[0], "D:\\Source\\first", "code", { path: "src/a.ts", line: 12 }], [
            scenario.ids[0],
            "D:\\Source\\first",
            "lint",
            { path: "src/a.ts" },
        ]])
        expect(scenario.workspace().repositories.map(repository => repository.lastFileScriptId)).toEqual(["lint", undefined])
        expect(scenario.lastScripts()).toEqual(["editor", undefined])
    })

    test("a script for worktrees doesn't run on a file, nor a File Script on a worktree", async () => {
        let scenario = scriptsScenario({ scripts: [editor, code] }, [{}])

        await scenario.scripts.runOnFile(scenario.ids[0], "D:\\Source\\first", "editor", { path: "src/a.ts" })
        await scenario.scripts.run(scenario.ids[0], "D:\\Source\\first", "code")

        expect(scenario.runs).toEqual([])
        expect(scenario.workspace().repositories[0]).not.toHaveProperty("lastScriptId")
        expect(scenario.workspace().repositories[0]).not.toHaveProperty("lastFileScriptId")
    })

    test("copying the path copies it, and the file buttons go back to copying", async () => {
        let scenario = scriptsScenario({ scripts: [code] }, [{ lastFileScriptId: "code" }])

        await scenario.scripts.runOnFile(scenario.ids[0], "D:\\Source\\first", "copy-path", { path: "src/a.ts" })

        expect(scenario.copied).toEqual(["src/a.ts"])
        expect(scenario.runs).toEqual([])
        expect(scenario.workspace().repositories[0].lastFileScriptId).toBe("copy-path")
    })

    test("a repository's files list its File Scripts alone, as the same object while they and the one repeated stay as they are", () => {
        let scenario = scriptsScenario({ scripts: [editor, code] }, [{ scripts: [build, lint], lastFileScriptId: "lint" }, {}])

        let listed = scenario.scripts.fileScripts(scenario.ids[0])
        // A save answers with a workspace of new objects.
        scenario.reload()
        let reloaded = scenario.scripts.fileScripts(scenario.ids[0])
        void scenario.scripts.runOnFile(scenario.ids[0], "D:\\Source\\first", "code", { path: "src/a.ts" })

        expect(listed).toEqual({ global: [code], own: [lint], last: lint })
        expect(reloaded == listed).toBe(true)
        expect(scenario.scripts.fileScripts(scenario.ids[0])).toEqual({ global: [code], own: [lint], last: code })
        expect(scenario.scripts.fileScripts(scenario.ids[1])).toEqual({ global: [code], own: [] })
    })

    test("a new one starts out for every repository, and saves as a File Script", () => {
        let scenario = scriptsScenario({}, [{ scripts: [build] }])

        scenario.scripts.create(scenario.ids[0], "file")
        scenario.scripts.setName("Code")
        scenario.scripts.setCommand("code {file}")
        scenario.scripts.save()

        let [saved] = scenario.workspace().scripts!
        expect(saved).toEqual({ id: saved.id, name: "Code", command: "code {file}", target: "file" })
        expect(scenario.workspace().repositories[0].scripts).toEqual([build])
    })

    test("deleting one has every repository's file buttons copy the path again, and Undo has them repeat it, leaving their script buttons alone", () => {
        let scenario = scriptsScenario({ scripts: [editor, code] }, [{ lastScriptId: "editor", lastFileScriptId: "code" }, { lastFileScriptId: "code" }])

        scenario.scripts.edit(scenario.ids[0], "code")
        scenario.scripts.delete()

        expect(scenario.workspace().scripts).toEqual([editor])
        expect(scenario.workspace().repositories.map(repository => repository.lastFileScriptId)).toEqual([undefined, undefined])

        scenario.notices.at(-1)!.action!.run()

        expect(scenario.workspace().scripts).toEqual([editor, code])
        expect(scenario.workspace().repositories.map(repository => repository.lastFileScriptId)).toEqual(["code", "code"])
        expect(scenario.lastScripts()).toEqual(["editor", undefined])
    })
})

/** A scripts controller over a workspace of repositories, each with the scripts given, which keeps what it changes. */
function scriptsScenario(
    saved: Pick<Workspace, "scripts">,
    repositories: Pick<Workspace["repositories"][number], "scripts" | "lastScriptId" | "lastFileScriptId">[],
) {
    let names = ["first", "second", "third"]
    let workspace: Workspace = {
        ...saved,
        repositories: repositories.map((scripts, index) => ({ ...openedWorkspace(repositoryInfo(`D:\\Source\\${names[index]}`)).repositories[0], ...scripts })),
    }
    let notices: Notice[] = []
    let runs: unknown[][] = []
    let copied: string[] = []
    let scripts = createRepositoryScripts({
        api: fakeLaneway({
            runScript: async (...run) => {
                runs.push(run)
                return { ok: true }
            },
        }),
        notify(notice) {
            notices.push(notice)
            return () => {}
        },
        workspace: () => workspace,
        platform: () => "win32",
        change: next => workspace = next,
        copy: async text => void copied.push(text),
    })
    return {
        scripts,
        notices,
        runs,
        copied,
        /** Replaces the workspace with a copy, as a save's answer does. */
        reload() {
            workspace = structuredClone(workspace)
        },
        ids: workspace.repositories.map(repository => repository.id),
        workspace: () => workspace,
        lastScripts: () => workspace.repositories.map(repository => repository.lastScriptId),
        /** Closes a repository, which leaves the workspace the renderer has. */
        close(id: string) {
            workspace = { ...workspace, repositories: workspace.repositories.filter(repository => repository.id != id) }
        },
    }
}
