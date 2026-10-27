import type { RepositoryIcon, RepositoryScript } from "@laneway/shared"
import { openFolderScriptId } from "@laneway/shared"
import { Fragment } from "react"
import { Button as AriaButton } from "react-aria-components"
import type { AppController } from "./app-controller"
import { AddIcon, ChevronDownIcon, ConfigureIcon, OpenFolderIcon } from "./icons"
import type { IconImageApi } from "./repository-icon-images"
import { lastScript, openFolderLabel } from "./repository-scripts"
import { RepositoryTile } from "./repository-tile"
import { Menu, MenuItem, MenuTrigger, Separator, Text } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshotValue } from "./use-snapshot"

/**
 * A worktree column's script button, a split button: its icon runs the repository's last script in the worktree, or
 * opens the worktree's folder before any has run, and its chevron lists opening the folder, then each script with a
 * gear beside it that configures or deletes it, then creating one.
 */
export function ScriptButton({ controller, repositoryId, path }: { controller: AppController; repositoryId: string; path: string }) {
    let repository = useSnapshotValue(
        controller,
        snapshot => snapshot.status == "ready" ? snapshot.workspace.repositories.find(item => item.id == repositoryId) : undefined,
    )
    let platform = useSnapshotValue(controller, snapshot => snapshot.status == "ready" ? snapshot.platform : "")
    let { scripts } = controller
    if (!repository)
        return null
    let folder = openFolderLabel(platform)
    let last = lastScript(repository)
    let label = last ? `Run ${last.name}` : folder
    let run = (scriptId: string) => void scripts.run(repositoryId, path, scriptId)
    return (
        <div className="script-split">
            <TooltipTrigger>
                <AriaButton className="icon-button script-run" aria-label={label} onPress={() => run(last?.id ?? openFolderScriptId)}>
                    {last ? <ScriptTile script={last} api={scripts.images} /> : <OpenFolderIcon />}
                </AriaButton>
                <Tooltip>{label}</Tooltip>
            </TooltipTrigger>
            <MenuTrigger>
                <TooltipTrigger>
                    <AriaButton className="icon-button script-more" aria-label="Scripts">
                        <ChevronDownIcon />
                    </AriaButton>
                    <Tooltip>Scripts</Tooltip>
                </TooltipTrigger>
                <Menu aria-label="Scripts" className="react-aria-Menu script-menu">
                    <MenuItem textValue={folder} onAction={() => run(openFolderScriptId)}>
                        <OpenFolderIcon />
                        <Text slot="label">{folder}</Text>
                    </MenuItem>
                    {/* React Aria's menu items can't hold buttons, so the gear is the next item, sharing the row. */}
                    {repository.scripts?.map(script => (
                        <Fragment key={script.id}>
                            <MenuItem className="react-aria-MenuItem split-action" textValue={script.name} onAction={() => run(script.id)}>
                                <ScriptTile script={script} api={scripts.images} />
                                <Text slot="label">{script.name}</Text>
                            </MenuItem>
                            <MenuItem
                                className="react-aria-MenuItem split-more script-configure"
                                aria-label={`Configure ${script.name}`}
                                textValue={`Configure ${script.name}`}
                                onAction={() => scripts.edit(repositoryId, script.id)}
                            >
                                <ConfigureIcon />
                            </MenuItem>
                        </Fragment>
                    ))}
                    <Separator />
                    <MenuItem textValue="New script" onAction={() => scripts.create(repositoryId)}>
                        <AddIcon />
                        <Text slot="label">New script…</Text>
                    </MenuItem>
                </Menu>
            </MenuTrigger>
        </div>
    )
}

// Initials have nothing to draw before a script has a name.
let unnamed: RepositoryIcon = { kind: "monogram", text: "", color: "gray" }

/**
 * A script's icon on a tile like a Repository Icon's, its name's initials without one. Only letters keep the tile's
 * frame, so icons, emoji, and pictures stand alone as other glyphs do.
 */
export function ScriptTile({ script, api, className = "tile script-tile" }: {
    script: Pick<RepositoryScript, "name" | "icon">
    api: IconImageApi
    className?: string
}) {
    return <RepositoryTile className={className} icon={script.icon ?? (script.name.trim() ? undefined : unnamed)} name={script.name} api={api} />
}
