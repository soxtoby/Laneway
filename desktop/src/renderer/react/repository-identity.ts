import type { RepositoryIdentity, Workspace } from "@laneway/shared"
import { repositoryInitials, RepositoryLabelSchema } from "@laneway/shared"
import { chosenIcon, type IconChoice, iconChoice, type IconChooser, iconChooser, imageScanner } from "./icon-choice"
import { automaticIcon, repositoryName } from "./repositories"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface IdentitySnapshot extends IconChoice {
    /** The repository being customized; absent while the editor is closed. */
    repositoryId?: string
    label: string
}

export interface RepositoryIdentityEditor extends Store<IdentitySnapshot>, IconChooser {
    open(repositoryId: string): void
    close(): void
    setLabel(label: string): void
    /** Returns to the default name and icon. */
    reset(): void
}

interface IdentityOptions {
    api: Api
    workspace(): Workspace | undefined
    /** Applies the identity at once; the editor stays open for further changes. */
    commit(repositoryId: string, identity: RepositoryIdentity): void
}

/**
 * A repository's name and icon in Laneway, which apply as they are chosen. Without an override the
 * editor opens on the tab the default came from, favicon or initials, and writes nothing until an
 * icon control is touched.
 */
export function createRepositoryIdentityEditor({ api, workspace, commit }: IdentityOptions): RepositoryIdentityEditor {
    let store = createStore<IdentitySnapshot>({ label: "", ...iconChoice(undefined, "monogram", "") })
    let state = store.snapshot
    let update = (change: Partial<IdentitySnapshot>) => store.publish({ ...state(), ...change })
    let images = imageScanner(api, update)

    function repository() {
        let id = state().repositoryId
        return workspace()?.repositories.find(candidate => candidate.id == id)
    }

    function identity(): RepositoryIdentity {
        let label = RepositoryLabelSchema.safeParse(state().label)
        let chosen = chosenIcon(state(), repository()?.icon)
        return { ...label.success ? { label: label.data } : {}, ...chosen ? { icon: chosen } : {} }
    }

    function scanImages() {
        let id = state().repositoryId
        if (id)
            images.scan(id)
    }

    function apply(change: Partial<IdentitySnapshot>) {
        update(change)
        let id = state().repositoryId
        if (!id)
            return
        commit(id, identity())
        // Untouched initials keep following the name as it is typed.
        let current = repository()
        if (!state().iconTouched && current)
            update({ monogram: repositoryInitials(repositoryName(current)) })
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        ...iconChooser({ apply, update, scanImages }),

        open(repositoryId) {
            let current = workspace()?.repositories.find(candidate => candidate.id == repositoryId)
            if (!current)
                return
            let choice = iconChoice(current.icon, automaticIcon(current) ? "image" : "monogram", repositoryInitials(repositoryName(current)))
            images.reset()
            update({ repositoryId, label: current.label ?? "", ...choice })
            if (choice.mode == "image")
                images.scan(repositoryId)
        },

        close() {
            update({ repositoryId: undefined })
        },

        setLabel(label) {
            apply({ label })
        },

        reset() {
            let current = repository()
            apply({ label: "", iconTouched: false, mode: current && automaticIcon(current) ? "image" : "monogram", color: "gray", imagePath: undefined })
        },
    }
}
