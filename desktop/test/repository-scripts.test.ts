import { parseWorkspacePresentation } from "@laneway/settings"
import type { RepositoryScript, Workspace } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import type { Notice } from "../src/renderer/react/notice"
import { createRepositoryScripts } from "../src/renderer/react/repository-scripts"
import { fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let editor: RepositoryScript = { id: "editor", name: "Editor", command: "code ." }
let terminal: RepositoryScript = { id: "terminal", name: "Terminal", command: "wt -d ." }
let build: RepositoryScript = { id: "build", name: "Build", command: "bun run build" }

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

/** A scripts controller over a workspace of repositories, each with the scripts given, which keeps what it changes. */
function scriptsScenario(saved: Pick<Workspace, "scripts">, repositories: { scripts?: RepositoryScript[]; lastScriptId?: string }[]) {
    let names = ["first", "second", "third"]
    let workspace: Workspace = {
        ...saved,
        repositories: repositories.map((scripts, index) => ({ ...openedWorkspace(repositoryInfo(`D:\\Source\\${names[index]}`)).repositories[0], ...scripts })),
    }
    let notices: Notice[] = []
    let runs: string[][] = []
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
    })
    return {
        scripts,
        notices,
        runs,
        ids: workspace.repositories.map(repository => repository.id),
        workspace: () => workspace,
        lastScripts: () => workspace.repositories.map(repository => repository.lastScriptId),
        /** Closes a repository, which leaves the workspace the renderer has. */
        close(id: string) {
            workspace = { ...workspace, repositories: workspace.repositories.filter(repository => repository.id != id) }
        },
    }
}
