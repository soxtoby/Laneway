import type { ChangedFile, RepositoryScript } from "@laneway/shared"
import { copyPathScriptId } from "@laneway/shared"
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Button as AriaButton } from "react-aria-components"
import type { AppController } from "./app-controller"
import { copyText } from "./file-paths"
import { AddIcon, CheckIcon, ChevronDownIcon, CopyIcon } from "./icons"
import type { IconImageApi } from "./repository-icon-images"
import type { FileScripts } from "./repository-scripts"
import { scriptMenuItems, ScriptTile } from "./script-button"
import { Menu, MenuItem, MenuTrigger, Separator, Text } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { RepositoryScope } from "./use-snapshot"

/** The app whose File Scripts files run. Outside one, as in a list drawn alone, files only copy their paths. */
export let FileScriptsScope = createContext<AppController | undefined>(undefined)

/** A repository's File Scripts, run on the files of one worktree. */
export interface FileScriptRunner extends FileScripts {
    /** Reads the image files script icons show. */
    images: IconImageApi
    /** Runs a File Script on a file, at the line chosen in its diff, or copies the file's path, and has the file buttons repeat it. */
    run(scriptId: string, path: string, line?: number): Promise<void>
    edit(scriptId: string): void
    create(): void
}

/**
 * The File Scripts that run on a file: none on one its change deleted, which the worktree no longer has, or on a
 * submodule, which is a folder there.
 */
export function scriptsOn(file: ChangedFile, scripts?: FileScriptRunner) {
    return file.status == "deleted" || file.submodule ? undefined : scripts
}

let idle = () => () => {}

/**
 * The File Scripts of the repository in scope, for files in the worktree at `root`; nothing for files that have no
 * worktree to run in. A list reads them once for its rows, and they stay the same object until one changes, so the
 * rows aren't drawn again each time the workspace saves.
 */
export function useFileScripts(root?: string): FileScriptRunner | undefined {
    let controller = useContext(FileScriptsScope)
    let repositoryId = useContext(RepositoryScope)
    let listed = useSyncExternalStore(controller?.subscribe ?? idle, () => repositoryId ? controller?.scripts.fileScripts(repositoryId) : undefined)
    return useMemo(() => {
        if (!controller || !repositoryId || !root || !listed)
            return undefined
        let { scripts } = controller
        return {
            ...listed,
            images: scripts.images,
            run: (scriptId, path, line) => scripts.runOnFile(repositoryId, root, scriptId, { path, ...line ? { line } : {} }),
            edit: scriptId => scripts.edit(repositoryId, scriptId),
            create: () => scripts.create(repositoryId, "file"),
        }
    }, [controller, repositoryId, root, listed])
}

/** Whether a copy was just made, which its button shows for a moment, and what says one was. */
function useCopied() {
    let [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied)
            return
        let timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
    }, [copied])
    return [copied, () => setCopied(true)] as const
}

function CopyButton({ path, className, copied, onPress }: { path: string; className: string; copied: boolean; onPress(): void }) {
    return (
        <TooltipTrigger>
            <AriaButton className={className} aria-label={`Copy relative path of ${path}`} data-copied={copied || undefined} onPress={onPress}>
                {copied ? <CheckIcon /> : <CopyIcon />}
            </AriaButton>
            <Tooltip>{copied ? "Copied" : "Copy relative path"}</Tooltip>
        </TooltipTrigger>
    )
}

/** Copies the file's repository-relative path; it shows while the file's row is hovered or focused, and confirms the copy. */
export function CopyPathButton({ path }: { path: string }) {
    let [copied, confirm] = useCopied()
    return <CopyButton path={path} className="copy-path icon-button small" copied={copied} onPress={() => void copyText(path).then(confirm)} />
}

/**
 * The script button on a file's toolbar in a diff column, shown while the toolbar is hovered or focused. It is a split
 * button like a worktree column's: its icon repeats the repository's last File Script on the file, or copies the
 * file's repository-relative path before any has run, confirming the copy, and its chevron lists copying the path,
 * then the File Scripts saved for every repository, then the repository's own, each with a gear that configures or
 * deletes it, then creating one. A file with no worktree to run in has only the button that copies its path.
 */
export function FileScriptButton({ path, scripts }: { path: string; scripts?: FileScriptRunner }) {
    let [copied, confirm] = useCopied()
    if (!scripts)
        return <CopyPathButton path={path} />
    let last = scripts.last
    let run = (scriptId: string) => {
        let ran = scripts.run(scriptId, path)
        if (scriptId == copyPathScriptId)
            void ran.then(confirm)
    }
    let actions = { run, edit: scripts.edit, images: scripts.images }
    return (
        <span className="copy-path file-script-split" data-copied={copied || undefined}>
            {last
                ? (
                    <TooltipTrigger>
                        <AriaButton
                            className="icon-button small file-script script-run"
                            aria-label={`Run ${last.name} on ${path}`}
                            onPress={() => run(last.id)}
                        >
                            <ScriptTile script={last} api={scripts.images} />
                        </AriaButton>
                        <Tooltip>Run {last.name}</Tooltip>
                    </TooltipTrigger>
                )
                : <CopyButton path={path} className="icon-button small file-script script-run" copied={copied} onPress={() => run(copyPathScriptId)} />}
            <MenuTrigger>
                <TooltipTrigger>
                    <AriaButton className="icon-button small script-more" aria-label={`File scripts for ${path}`}>
                        <ChevronDownIcon />
                    </AriaButton>
                    <Tooltip>File scripts</Tooltip>
                </TooltipTrigger>
                <Menu aria-label="File scripts" className="react-aria-Menu script-menu">
                    <MenuItem textValue="Copy relative path" onAction={() => run(copyPathScriptId)}>
                        <CopyIcon />
                        <Text slot="label">Copy relative path</Text>
                    </MenuItem>
                    {scriptMenuItems(scripts.global, actions)}
                    {/* The line parts the File Scripts every repository has, as it has copying the path, from its own. */}
                    {scripts.global.length && scripts.own.length ? <Separator /> : null}
                    {scriptMenuItems(scripts.own, actions)}
                    <Separator />
                    <MenuItem textValue="New file script" onAction={scripts.create}>
                        <AddIcon />
                        <Text slot="label">New file script…</Text>
                    </MenuItem>
                </Menu>
            </MenuTrigger>
        </span>
    )
}

/** A file's menu items that run each File Script on it, under its icon, then a line parting them from what follows. */
export function FileScriptItems({ path, scripts }: { path: string; scripts?: FileScriptRunner }): ReactNode {
    let listed = scripts ? [...scripts.global, ...scripts.own] : []
    return listed.length > 0 && scripts && (
        <>
            {listed.map(script => (
                <MenuItem key={script.id} textValue={script.name} onAction={() => void scripts.run(script.id, path)}>
                    <ScriptTile script={script} api={scripts.images} />
                    <Text slot="label">{script.name}</Text>
                </MenuItem>
            ))}
            <Separator />
        </>
    )
}

/**
 * A diff line's menu, laid out as its file's script menu is: copying the path with the line, then each File Script,
 * which runs on the file at that line, those saved for every repository parted from the repository's own. Copying
 * here leaves the file buttons repeating what they did, as copying from a file's own menu does. A file with no
 * worktree to run in only copies.
 */
export function FileLineItems({ path, line, scripts }: { path: string; line: number; scripts?: FileScriptRunner }) {
    let images = scripts?.images
    let items = (listed: RepositoryScript[] = []) =>
        listed.map(script => (
            <MenuItem key={script.id} textValue={script.name} onAction={() => void scripts?.run(script.id, path, line)}>
                {images && <ScriptTile script={script} api={images} />}
                <Text slot="label">{script.name}</Text>
            </MenuItem>
        ))
    return (
        <>
            <MenuItem textValue="Copy path and line" onAction={() => void copyText(`${path}:${line}`)}>
                <CopyIcon />
                <Text slot="label">Copy path and line</Text>
            </MenuItem>
            {items(scripts?.global)}
            {scripts?.global.length && scripts.own.length ? <Separator /> : null}
            {items(scripts?.own)}
        </>
    )
}
