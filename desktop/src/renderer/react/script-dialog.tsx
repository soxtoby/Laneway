import type { OpenRepository, Workspace } from "@laneway/shared"
import { repositoryInitials } from "@laneway/shared"
import { useState } from "react"
import { chosenIcon } from "./icon-choice"
import { IconFields } from "./icon-pickers"
import { repositoryName } from "./repositories"
import type { RepositoryScriptsController, ScriptEditorSnapshot } from "./repository-scripts"
import { ScriptTile } from "./script-button"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

/** Creating or configuring a Repository Script, which saves on Save; a saved one also deletes from here, with Undo. */
export function ScriptDialog({ scripts, workspace }: { scripts: RepositoryScriptsController; workspace: Workspace }) {
    let state = useSnapshot(scripts)
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(state)
    if (state.repositoryId && state != last)
        setLast(state)
    let shown = state.repositoryId ? state : last
    let repository = workspace.repositories.find(candidate => candidate.id == shown.repositoryId)
    return (
        <Modal isOpen={state.repositoryId != undefined && repository != undefined} onOpenChange={isOpen => isOpen || scripts.close()}>
            <Dialog className="react-aria-Dialog identity-dialog script-dialog">
                {repository && <ScriptFields scripts={scripts} state={shown} repository={repository} />}
            </Dialog>
        </Modal>
    )
}

function ScriptFields({ scripts, state, repository }: { scripts: RepositoryScriptsController; state: ScriptEditorSnapshot; repository: OpenRepository }) {
    let saved = repository.scripts?.find(script => script.id == state.scriptId)
    let initials = state.name.trim() ? repositoryInitials(state.name) : ""
    return (
        <Form
            className="react-aria-Form script-form"
            onSubmit={event => {
                event.preventDefault()
                scripts.save()
            }}
        >
            <header className="identity-header">
                <ScriptTile className="tile identity-preview" script={{ name: state.name, icon: chosenIcon(state, saved?.icon) }} api={scripts.images} />
                <div className="identity-title">
                    <Heading slot="title">{saved ? `Configure ${saved.name}` : "New script"}</Heading>
                    <span className="identity-path">{repositoryName(repository)}</span>
                </div>
            </header>
            <TextField label="Name" value={state.name} onChange={scripts.setName} maxLength={80} autoComplete="off" autoFocus />
            <TextField
                label="Command"
                className="react-aria-TextField script-command"
                value={state.command}
                onChange={scripts.setCommand}
                maxLength={4000}
                autoComplete="off"
                spellCheck="false"
                description="Runs in the worktree's directory, as if typed at its command prompt."
            />
            <Checkbox
                isSelected={state.terminal}
                onChange={scripts.setTerminal}
                description="Its output shows in a window that stays open. Otherwise it runs with no window, and its output shows only if it fails."
            >
                Open in a terminal
            </Checkbox>
            <IconFields
                chooser={scripts}
                choice={state}
                initials={initials}
                owner="script"
                images={{
                    available: repository.status == "available",
                    current: state.imagePath,
                    note: "The file is read from where it is; moving it clears the icon.",
                }}
                api={scripts.images}
            />
            <div className="dialog-actions">
                {saved && <Button variant="quiet" className="dialog-delete" onPress={scripts.delete}>Delete</Button>}
                <Button variant="secondary" onPress={scripts.close}>Cancel</Button>
                <Button type="submit" variant="accent" isDisabled={!state.name.trim() || !state.command.trim()}>Save</Button>
            </div>
        </Form>
    )
}
