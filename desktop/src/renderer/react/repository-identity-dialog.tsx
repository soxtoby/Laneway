import type { OpenRepository } from "@laneway/shared"
import { repositoryInitials } from "@laneway/shared"
import { Hint } from "./controls"
import { IconFields } from "./icon-pickers"
import { automaticIcon, baseName, repositoryFolderName } from "./repositories"
import type { IconImageApi } from "./repository-icon-images"
import type { IdentitySnapshot, RepositoryIdentityEditor } from "./repository-identity"
import { RepositoryTile } from "./repository-tile"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

/** The repository customization dialog: a name and an icon that apply as they are chosen. */
export function RepositoryIdentityDialog(
    { editor, repositories, api }: { editor: RepositoryIdentityEditor; repositories: OpenRepository[]; api: IconImageApi },
) {
    let state = useSnapshot(editor)
    let repository = repositories.find(candidate => candidate.id == state.repositoryId)
    return (
        <Modal isOpen={repository != undefined} onOpenChange={isOpen => isOpen || editor.close()}>
            <Dialog className="react-aria-Dialog identity-dialog">
                {repository && <IdentityFields editor={editor} state={state} repository={repository} api={api} />}
            </Dialog>
        </Modal>
    )
}

function IdentityFields(
    { editor, state, repository, api }: { editor: RepositoryIdentityEditor; state: IdentitySnapshot; repository: OpenRepository; api: IconImageApi },
) {
    let folder = repositoryFolderName(repository)
    let name = state.label.trim() || folder
    let automatic = automaticIcon(repository)
    return (
        <>
            <header className="identity-header">
                <RepositoryTile className="tile identity-preview" icon={repository.icon ?? automatic} name={name} api={api} />
                <div className="identity-title">
                    <Heading slot="title">{name}</Heading>
                    <Hint text={repository.path}>
                        <span className="identity-path">{repository.path}</span>
                    </Hint>
                </div>
            </header>
            <TextField
                label="Name"
                value={state.label}
                onChange={editor.setLabel}
                placeholder={folder}
                maxLength={120}
                autoComplete="off"
                description="Only the label in Laneway changes; the folder keeps its name."
            />
            <IconFields
                chooser={editor}
                choice={state}
                initials={repositoryInitials(name)}
                owner="repository"
                images={{
                    available: repository.status == "available",
                    current: repository.icon?.kind == "image" ? repository.icon.path : automatic?.path,
                    note: `${
                        repository.icon?.kind == "image"
                            ? `Using ${repository.icon.path}. `
                            : automatic
                            ? `Using the favicon ${baseName(automatic.path)} found in the repository. `
                            : ""
                    }The file is read from where it is; moving it clears the icon.`,
                }}
                api={api}
            />
            <div className="dialog-actions">
                <Button variant="secondary" onPress={editor.reset}>Reset</Button>
                <Button variant="accent" onPress={editor.close}>Done</Button>
            </div>
        </>
    )
}
