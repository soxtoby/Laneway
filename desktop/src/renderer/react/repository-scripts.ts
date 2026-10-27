import type { OpenRepository, RepositoryScript, RepositoryScripts, Workspace } from "@laneway/shared"
import { openFolderScriptId, repositoryInitials, RepositoryScriptSchema } from "@laneway/shared"
import { undoWindowMs } from "./discard"
import { chosenIcon, type IconChoice, iconChoice, type IconChooser, iconChooser, imageScanner } from "./icon-choice"
import { errorMessage, type Notice } from "./notice"
import type { IconImageApi } from "./repository-icon-images"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface ScriptEditorSnapshot extends IconChoice {
    /** The repository whose script is edited; absent while the editor is closed. */
    repositoryId?: string
    /** The script being changed; absent for a new one. */
    scriptId?: string
    name: string
    command: string
    terminal: boolean
}

/** Running a repository's scripts from its worktree columns, and the dialog that creates, changes, and deletes them. */
export interface RepositoryScriptsController extends Store<ScriptEditorSnapshot>, IconChooser {
    /** Reads the image files script icons show. */
    readonly images: IconImageApi
    /** Runs a script, or opens the folder, in a worktree, and makes it the one the repository's script buttons repeat. */
    run(repositoryId: string, path: string, scriptId: string): Promise<void>
    create(repositoryId: string): void
    edit(repositoryId: string, scriptId: string): void
    setName(name: string): void
    setCommand(command: string): void
    setTerminal(terminal: boolean): void
    /** Saves the script being edited, a new one last; nothing saves while its name or command is empty. */
    save(): void
    /** Deletes the script being edited at once, offering Undo. */
    delete(): void
    close(): void
}

interface ScriptsOptions {
    api: Api
    notify(notice: Notice): () => void
    workspace(): Workspace | undefined
    /** Node's name for the operating system, which names its file manager. */
    platform(): string
    /** Shows a repository's scripts at once and saves them. */
    change(repositoryId: string, scripts: RepositoryScripts): void
}

/** What opening the folder is called where it opens. */
export function openFolderLabel(platform: string) {
    return platform == "win32" ? "Open in File Explorer" : platform == "darwin" ? "Open in Finder" : "Open in file manager"
}

/** The script a repository's script buttons repeat, or nothing while they open the folder. */
export function lastScript(repository: OpenRepository) {
    return repository.scripts?.find(script => script.id == repository.lastScriptId)
}

// A script without a name yet has no initials, rather than a placeholder's.
function initials(name: string) {
    return name.trim() ? repositoryInitials(name) : ""
}

/**
 * A repository's Repository Scripts. A script runs in the worktree whose column ran it, and the dialog saves what it
 * holds only on Save, while deleting applies at once with Undo. Untouched initials follow the name as it is typed.
 */
export function createRepositoryScripts({ api, notify, workspace, platform, change }: ScriptsOptions): RepositoryScriptsController {
    let store = createStore<ScriptEditorSnapshot>({ name: "", command: "", terminal: false, ...iconChoice(undefined, "monogram", "") })
    let state = store.snapshot
    let update = (change: Partial<ScriptEditorSnapshot>) => store.publish({ ...state(), ...change })
    let images = imageScanner(api, update)

    function repository(id = state().repositoryId) {
        return workspace()?.repositories.find(candidate => candidate.id == id)
    }

    function scanImages() {
        let id = state().repositoryId
        if (id)
            images.scan(id)
    }

    function open(repositoryId: string, script?: RepositoryScript) {
        let choice = iconChoice(script?.icon, "monogram", initials(script?.name ?? ""))
        images.reset()
        update({ repositoryId, scriptId: script?.id, name: script?.name ?? "", command: script?.command ?? "", terminal: script?.terminal == true, ...choice })
        if (choice.mode == "image")
            images.scan(repositoryId)
    }

    let controller: RepositoryScriptsController = {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        images: api,
        ...iconChooser({ apply: update, update, scanImages }),

        async run(repositoryId, path, scriptId) {
            let current = repository(repositoryId)
            let name = scriptId == openFolderScriptId ? openFolderLabel(platform()) : current?.scripts?.find(script => script.id == scriptId)?.name
            if (!current || !name)
                return
            if ((current.lastScriptId ?? openFolderScriptId) != scriptId)
                change(repositoryId, { scripts: current.scripts, lastScriptId: scriptId })
            try {
                let result = await api.runScript(repositoryId, path, scriptId)
                if (!result.ok)
                    notify({ code: "script.failed", message: `${name} failed. ${result.message}`, output: result.output })
            } catch (error) {
                notify({ code: "script.failed", message: `${name} failed. ${errorMessage(error)}` })
            }
        },

        create(repositoryId) {
            open(repositoryId)
        },

        edit(repositoryId, scriptId) {
            let script = repository(repositoryId)?.scripts?.find(candidate => candidate.id == scriptId)
            if (script)
                open(repositoryId, script)
        },

        setName(name) {
            update({ name, ...state().iconTouched ? {} : { monogram: initials(name) } })
        },

        setCommand(command) {
            update({ command })
        },

        setTerminal(terminal) {
            update({ terminal })
        },

        save() {
            let { repositoryId, scriptId, name, command, terminal } = state()
            let current = repository()
            let previous = current?.scripts?.find(script => script.id == scriptId)
            let icon = chosenIcon(state(), previous?.icon)
            let parsed = RepositoryScriptSchema.safeParse({
                id: scriptId ?? crypto.randomUUID(),
                name: name.trim(),
                command: command.trim(),
                ...icon ? { icon } : {},
                ...terminal ? { terminal } : {},
            })
            if (!repositoryId || !current || !parsed.success)
                return
            let scripts = current.scripts ?? []
            change(repositoryId, {
                scripts: previous ? scripts.map(script => script.id == previous.id ? parsed.data : script) : [...scripts, parsed.data],
                lastScriptId: current.lastScriptId,
            })
            controller.close()
        },

        delete() {
            let { repositoryId, scriptId } = state()
            let current = repository()
            let index = current?.scripts?.findIndex(script => script.id == scriptId) ?? -1
            if (!repositoryId || !current?.scripts || index < 0)
                return
            let deleted = current.scripts[index]
            let wasLast = current.lastScriptId == deleted.id
            change(repositoryId, { scripts: current.scripts.filter(script => script != deleted), lastScriptId: wasLast ? undefined : current.lastScriptId })
            controller.close()
            // Undo puts it back where it was among the scripts there are by then.
            notify({
                code: "script.deleted",
                message: `Deleted script ${deleted.name}.`,
                transient: true,
                duration: undoWindowMs,
                action: {
                    label: "Undo",
                    run() {
                        let restored = repository(repositoryId)
                        if (!restored || restored.scripts?.some(script => script.id == deleted.id))
                            return
                        let scripts = [...restored.scripts ?? []]
                        scripts.splice(index, 0, deleted)
                        change(repositoryId, { scripts, lastScriptId: wasLast ? deleted.id : restored.lastScriptId })
                    },
                },
            })
        },

        close() {
            update({ repositoryId: undefined })
        },
    }
    return controller
}
