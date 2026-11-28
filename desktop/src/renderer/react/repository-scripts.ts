import type { RepositoryScript, RepositoryScripts, ScriptFile, ScriptRunResult, Workspace } from "@laneway/shared"
import { copyPathScriptId, openFolderScriptId, repositoryInitials, RepositoryScriptSchema } from "@laneway/shared"
import { undoWindowMs } from "./discard"
import { chosenIcon, type IconChoice, iconChoice, type IconChooser, iconChooser, imageScanner } from "./icon-choice"
import { errorMessage, type Notice } from "./notice"
import type { IconImageApi } from "./repository-icon-images"
import { sharedSnapshot } from "./shared-snapshot"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface ScriptEditorSnapshot extends IconChoice {
    /** The repository whose script menu opened the editor; absent while the editor is closed. */
    repositoryId?: string
    /** The script being changed; absent for a new one. */
    scriptId?: string
    name: string
    command: string
    terminal: boolean
    /** Saved for every repository, rather than only the one that opened the editor. */
    global: boolean
    /** A File Script, which a file's menu opened the editor for. */
    target?: "file"
}

/** The File Scripts a repository's files list, and the one their buttons repeat. */
export interface FileScripts {
    /** Those saved for every repository. */
    global: RepositoryScript[]
    /** The repository's own. */
    own: RepositoryScript[]
    /** The last one run in the repository; nothing while the buttons copy the file's path. */
    last?: RepositoryScript
}

/**
 * Running a repository's scripts from its worktree columns, and its File Scripts from its files, and the dialog that
 * creates, changes, and deletes them.
 */
export interface RepositoryScriptsController extends Store<ScriptEditorSnapshot>, IconChooser {
    /** Reads the image files script icons show. */
    readonly images: IconImageApi
    /** Runs a script, or opens the folder, in a worktree, and makes it the one the repository's script buttons repeat. */
    run(repositoryId: string, path: string, scriptId: string): Promise<void>
    /**
     * Runs a File Script on a file in the worktree at `path`, at the line chosen in its diff, or copies the file's
     * path, and makes it the one the repository's file buttons repeat.
     */
    runOnFile(repositoryId: string, path: string, scriptId: string, file: ScriptFile): Promise<void>
    /** A repository's File Scripts, the same object until one of them or the one repeated changes. */
    fileScripts(repositoryId: string): FileScripts | undefined
    /** Opens the editor for a new script, a File Script from a file's menu. */
    create(repositoryId: string, target?: "file"): void
    edit(repositoryId: string, scriptId: string): void
    setName(name: string): void
    setCommand(command: string): void
    setTerminal(terminal: boolean): void
    setGlobal(global: boolean): void
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
    /** Shows the workspace with its scripts changed at once and saves it. */
    change(workspace: Workspace): void
    /** Puts text on the clipboard. */
    copy(text: string): Promise<unknown>
}

/** What opening the folder is called where it opens. */
export function openFolderLabel(platform: string) {
    return platform == "win32" ? "Open in File Explorer" : platform == "darwin" ? "Open in Finder" : "Open in file manager"
}

/** The scripts a repository has, File Scripts among them: those saved for every repository, then its own. */
export function availableScripts(global: RepositoryScript[] | undefined, repository: RepositoryScripts | undefined) {
    return [...global ?? [], ...repository?.scripts ?? []]
}

/** The scripts of a list that run in a worktree, which its column's script menu shows. */
export function worktreeScripts(scripts: RepositoryScript[] | undefined) {
    return scriptsFor(scripts, undefined)
}

/** The scripts of a list with one target: a worktree's, which name none, or a file's. */
function scriptsFor(scripts: RepositoryScript[] | undefined, target: "file" | undefined) {
    return scripts?.filter(script => script.target == target) ?? []
}

/** The script a repository's script buttons repeat, or nothing while they open the folder. */
export function lastScript(global: RepositoryScript[] | undefined, repository: RepositoryScripts) {
    return availableScripts(global, repository).find(script => script.id == repository.lastScriptId && !script.target)
}

/** Where a repository keeps the script its buttons repeat, and what they do before any ran: a worktree's, or a file's. */
function repeating(target?: "file") {
    return target == "file"
        ? { field: "lastFileScriptId" as const, builtIn: copyPathScriptId }
        : { field: "lastScriptId" as const, builtIn: openFolderScriptId }
}

// A script without a name yet has no initials, rather than a placeholder's.
function initials(name: string) {
    return name.trim() ? repositoryInitials(name) : ""
}

/**
 * The workspace with the scripts for every repository, and one repository's own, replaced. A script button whose script
 * its repository no longer has opens the folder again, and a file's copies its path.
 */
function withScripts(workspace: Workspace, repositoryId: string, global: RepositoryScript[], own: RepositoryScript[]): Workspace {
    let repositories = workspace.repositories.map(repository => {
        let scripts = repository.id == repositoryId ? own : repository.scripts ?? []
        let changed = { ...repository }
        if (scripts.length)
            changed.scripts = scripts
        else
            delete changed.scripts
        for (let target of [undefined, "file"] as const) {
            let { field, builtIn } = repeating(target)
            let last = repository[field]
            if (last != builtIn && !scriptsFor([...global, ...scripts], target).some(script => script.id == last))
                delete changed[field]
        }
        return changed
    })
    let changed = { ...workspace, repositories }
    if (global.length)
        changed.scripts = global
    else
        delete changed.scripts
    return changed
}

/**
 * Repository Scripts, a repository's own and those saved for every repository. A script runs in the worktree whose
 * column ran it, and the dialog saves what it holds only on Save, moving a script whose repositories changed, while
 * deleting applies at once with Undo. Untouched initials follow the name as it is typed.
 */
export function createRepositoryScripts({ api, notify, workspace, platform, change, copy }: ScriptsOptions): RepositoryScriptsController {
    let store = createStore<ScriptEditorSnapshot>({ name: "", command: "", terminal: false, global: false, ...iconChoice(undefined, "monogram", "") })
    let state = store.snapshot
    let update = (change: Partial<ScriptEditorSnapshot>) => store.publish({ ...state(), ...change })
    let images = imageScanner(api, update)
    let listed = new Map<string, FileScripts>()

    function repository(id = state().repositoryId) {
        return workspace()?.repositories.find(candidate => candidate.id == id)
    }

    function scanImages() {
        let id = state().repositoryId
        if (id)
            images.scan(id)
    }

    function open(repositoryId: string, { script, global, target }: { script?: RepositoryScript; global: boolean; target: "file" | undefined }) {
        let choice = iconChoice(script?.icon, "monogram", initials(script?.name ?? ""))
        images.reset()
        update({
            repositoryId,
            scriptId: script?.id,
            name: script?.name ?? "",
            command: script?.command ?? "",
            terminal: script?.terminal == true,
            global,
            target,
            ...choice,
        })
        if (choice.mode == "image")
            images.scan(repositoryId)
    }

    // Has a repository's worktree buttons, or its file buttons, repeat a script it has, and answers with what a
    // failure calls it: nothing for a script it hasn't.
    function repeat(repositoryId: string, scriptId: string, target: "file" | undefined) {
        let { field, builtIn } = repeating(target)
        let current = workspace()
        let ran = repository(repositoryId)
        let name = scriptId != builtIn
            ? scriptsFor(availableScripts(current?.scripts, ran), target).find(script => script.id == scriptId)?.name
            : target
            ? "Copying the path"
            : openFolderLabel(platform())
        if (!current || !ran || !name)
            return undefined
        if ((ran[field] ?? builtIn) != scriptId) {
            let repositories = current.repositories.map(candidate => candidate == ran ? { ...ran, [field]: scriptId } : candidate)
            change({ ...current, repositories })
        }
        return name
    }

    async function report(name: string, run: () => Promise<ScriptRunResult | void>) {
        try {
            let result = await run()
            if (result && !result.ok)
                notify({ code: "script.failed", message: `${name} failed. ${result.message}`, output: result.output })
        } catch (error) {
            notify({ code: "script.failed", message: `${name} failed. ${errorMessage(error)}` })
        }
    }

    let controller: RepositoryScriptsController = {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        images: api,
        ...iconChooser({ apply: update, update, scanImages }),

        async run(repositoryId, path, scriptId) {
            let name = repeat(repositoryId, scriptId, undefined)
            if (name)
                await report(name, () => api.runScript(repositoryId, path, scriptId))
        },

        async runOnFile(repositoryId, path, scriptId, file) {
            let name = repeat(repositoryId, scriptId, "file")
            if (name)
                await report(name, () => scriptId == copyPathScriptId ? copy(file.path).then(() => {}) : api.runScript(repositoryId, path, scriptId, file))
        },

        fileScripts(repositoryId) {
            let current = workspace()
            let shown = repository(repositoryId)
            if (!current || !shown)
                return undefined
            let global = scriptsFor(current.scripts, "file")
            let own = scriptsFor(shown.scripts, "file")
            let last = [...global, ...own].find(script => script.id == shown.lastFileScriptId)
            // Every save answers with a workspace of new objects, which leave what the files list as it was.
            let next = sharedSnapshot(listed.get(repositoryId), { global, own, ...last ? { last } : {} })
            listed.set(repositoryId, next)
            return next
        },

        // An editor is wanted wherever there are files, so a new File Script starts out saved for every repository.
        create(repositoryId, target) {
            open(repositoryId, { global: target == "file", target })
        },

        edit(repositoryId, scriptId) {
            let global = workspace()?.scripts
            let script = availableScripts(global, repository(repositoryId)).find(candidate => candidate.id == scriptId)
            if (script)
                open(repositoryId, { script, global: global?.includes(script) == true, target: script.target })
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

        setGlobal(global) {
            update({ global })
        },

        save() {
            let { repositoryId, scriptId, name, command, terminal, global: toGlobal, target } = state()
            let current = workspace()
            let opened = repository()
            let global = current?.scripts ?? []
            let own = opened?.scripts ?? []
            let previous = [...global, ...own].find(script => script.id == scriptId)
            let kept = previous != undefined && global.includes(previous) == toGlobal
            let icon = chosenIcon(state(), previous?.icon)
            let parsed = RepositoryScriptSchema.safeParse({
                // A script that moves takes a new id, since a repository that isn't open may have a script, or a
                // last-run choice, with the one it had.
                id: previous && kept ? previous.id : crypto.randomUUID(),
                name: name.trim(),
                command: command.trim(),
                ...icon ? { icon } : {},
                ...terminal ? { terminal } : {},
                ...target ? { target } : {},
            })
            if (!repositoryId || !current || !opened || !parsed.success)
                return
            let script = parsed.data
            let { field } = repeating(target)
            // A script stays where it is among the others unless the repositories that have it changed, which moves it last.
            if (kept) {
                let replace = (scripts: RepositoryScript[]) => scripts.map(item => item == previous ? script : item)
                change(withScripts(current, repositoryId, replace(global), replace(own)))
            } else {
                let rest = (scripts: RepositoryScript[]) => scripts.filter(item => item != previous)
                let next = withScripts(current, repositoryId, [...rest(global), ...toGlobal ? [script] : []], [...rest(own), ...toGlobal ? [] : [script]])
                // The repository whose menu moved a script goes on repeating it under its new id.
                let repeats = previous != undefined && opened[field] == previous.id
                let repositories = next.repositories.map(candidate =>
                    repeats && candidate.id == repositoryId ? { ...candidate, [field]: script.id } : candidate
                )
                change({ ...next, repositories })
            }
            controller.close()
        },

        delete() {
            let { repositoryId, scriptId } = state()
            let current = workspace()
            let opened = repository()
            if (!repositoryId || !current || !opened)
                return
            let wasGlobal = current.scripts?.some(script => script.id == scriptId) == true
            let scripts = (wasGlobal ? current.scripts : opened.scripts) ?? []
            let index = scripts.findIndex(script => script.id == scriptId)
            if (index < 0)
                return
            let deleted = scripts[index]
            let rest = scripts.filter(script => script != deleted)
            let { field } = repeating(deleted.target)
            // Every repository has a script saved for them all, so any of their script buttons may have repeated it.
            let repeated = current.repositories.filter(candidate => candidate[field] == deleted.id).map(candidate => candidate.id)
            change(withScripts(current, repositoryId, wasGlobal ? rest : current.scripts ?? [], wasGlobal ? opened.scripts ?? [] : rest))
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
                        let restored = workspace()
                        let owner = restored?.repositories.find(candidate => candidate.id == repositoryId)
                        if (!restored || (!owner && !wasGlobal) || availableScripts(restored.scripts, owner).some(script => script.id == deleted.id))
                            return
                        let global = [...restored.scripts ?? []]
                        let own = [...owner?.scripts ?? []]
                        let returned = wasGlobal ? global : own
                        returned.splice(index, 0, deleted)
                        let next = withScripts(restored, repositoryId, global, own)
                        // A script button that has run no other script since repeats it again.
                        let repositories = next.repositories.map(candidate =>
                            repeated.includes(candidate.id) && !candidate[field] ? { ...candidate, [field]: deleted.id } : candidate
                        )
                        change({ ...next, repositories })
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
