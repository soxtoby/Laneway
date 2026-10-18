import { useMemo } from "react"
import { Autocomplete } from "react-aria-components"
import type { AppController } from "./app-controller"
import { lensResults } from "./command-lens"
import { Dialog } from "./ui/Dialog"
import { Menu, MenuItem } from "./ui/Menu"
import { Modal } from "./ui/Modal"
import { SearchField } from "./ui/SearchField"
import { useSnapshot } from "./use-snapshot"

let prompt = "Search open repositories and branches."
let kinds = { repository: "Repo", branch: "Branch", command: "Command" }

/**
 * The Command Lens: type to find an open repository, a branch in any of them, or a column command, and Enter to go
 * there. A branch shows in its repository's Branch Graph; the Lens never opens a column or switches a worktree.
 */
export function CommandLensDialog({ controller, workspace }: { controller: AppController; workspace: Parameters<typeof lensResults>[0]["workspace"] }) {
    let { lens, columns } = controller
    let { open, query, graphs } = useSnapshot(lens)
    let { repositoryId, graph, focusedId } = useSnapshot(columns)
    let results = useMemo(
        () =>
            lensResults({ workspace, graphs, shown: repositoryId ? { [repositoryId]: graph } : {}, activeId: repositoryId, focusedColumnId: focusedId, query }),
        [workspace, graphs, repositoryId, graph, focusedId, query],
    )
    // Results change with every keystroke, so their place in the list keys them.
    let items = results.map((result, index) => ({ ...result, id: String(index) }))
    return (
        <Modal isOpen={open} isDismissable onOpenChange={isOpen => isOpen || lens.close()}>
            <Dialog className="react-aria-Dialog command-lens" aria-label="Command Lens">
                <Autocomplete inputValue={query} onInputChange={lens.setQuery}>
                    <SearchField aria-label="Command Lens search" placeholder={prompt} autoFocus />
                    <Menu
                        aria-label="Matching repositories, branches, and commands"
                        className="react-aria-Menu lens-results"
                        items={items}
                        onAction={key => {
                            let result = items.find(item => item.id == key)
                            if (result)
                                void controller.activateLensResult(result)
                        }}
                        renderEmptyState={() => (
                            <p className="lens-guidance" role={query.trim() ? "status" : undefined}>{query.trim() ? "No matches." : prompt}</p>
                        )}
                    >
                        {result => (
                            <MenuItem id={result.id} textValue={result.label}>
                                <span className="lens-kind" data-kind={result.kind}>{kinds[result.kind]}</span>
                                <span className="lens-copy">
                                    <strong>{result.label}</strong>
                                    <small>{result.detail}</small>
                                </span>
                            </MenuItem>
                        )}
                    </Menu>
                </Autocomplete>
            </Dialog>
        </Modal>
    )
}
