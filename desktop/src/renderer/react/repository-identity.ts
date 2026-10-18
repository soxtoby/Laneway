import type { OpenRepository, RepositoryIcon, RepositoryIconColor, RepositoryIdentity, RepositoryImageFile, Workspace } from "@laneway/shared"
import { firstEmoji, monogramText, repositoryInitials, RepositoryLabelSchema } from "@laneway/shared"
import { automaticIcon, repositoryName } from "./repositories"
import { forgetIconImage } from "./repository-icon-images"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export type IconMode = RepositoryIcon["kind"]

let defaultIcon = "folder-code"
let defaultEmoji = "💻"
// Neutral, so a monogram that starts from the default initials changes as little as possible.
let defaultColor: RepositoryIconColor = "gray"

// A starting set that covers most projects; any other emoji can be pasted.
export let emojiOptions = [
    ["💻", "Laptop"],
    ["🛠️", "Tools"],
    ["🚀", "Rocket"],
    ["🤖", "Robot"],
    ["✨", "Sparkles"],
    ["⚡", "Lightning"],
    ["🌐", "Web"],
    ["📱", "Mobile"],
    ["🖥️", "Desktop"],
    ["⌨️", "Keyboard"],
    ["⚙️", "Gear"],
    ["🗄️", "Database"],
    ["☁️", "Cloud"],
    ["📦", "Package"],
    ["📚", "Books"],
    ["🧪", "Test tube"],
    ["🔒", "Lock"],
    ["🔑", "Key"],
    ["🎮", "Game"],
    ["🎵", "Music"],
    ["🎬", "Movie"],
    ["🖼️", "Picture"],
    ["🛍️", "Shopping"],
    ["🔥", "Fire"],
    ["💡", "Idea"],
    ["🧩", "Puzzle"],
    ["📊", "Chart"],
    ["🧠", "Brain"],
    ["🦄", "Unicorn"],
    ["🐙", "Octopus"],
    ["🌱", "Seedling"],
    ["🌍", "Globe"],
    ["🏠", "House"],
    ["🏗️", "Construction"],
    ["🧭", "Compass"],
    ["🔬", "Microscope"],
    ["🎨", "Palette"],
    ["📝", "Memo"],
    ["💬", "Speech"],
    ["📡", "Satellite"],
    ["🛰️", "Orbit"],
    ["🧰", "Toolbox"],
    ["🐳", "Whale"],
    ["🐍", "Snake"],
    ["🦀", "Crab"],
    ["🐘", "Elephant"],
    ["🦊", "Fox"],
    ["🐧", "Penguin"],
    ["🍀", "Clover"],
    ["⭐", "Star"],
] as const

export interface IdentitySnapshot {
    /** The repository being customized; absent while the editor is closed. */
    repositoryId?: string
    label: string
    mode: IconMode
    /** False while the icon is still the default, so a tab shows what was inferred rather than a choice. */
    iconTouched: boolean
    iconName: string
    color: RepositoryIconColor
    emoji: string
    pastedEmoji: string
    /** The monogram field's text, which may not yet be valid letters. */
    monogram: string
    iconQuery: string
    /** The repository's image files; absent while they are scanned. */
    images?: RepositoryImageFile[]
    imageQuery: string
}

export interface RepositoryIdentityEditor extends Store<IdentitySnapshot> {
    open(repositoryId: string): void
    close(): void
    setLabel(label: string): void
    setMode(mode: IconMode): void
    setIconName(name: string): void
    setColor(color: RepositoryIconColor): void
    setEmoji(emoji: string): void
    /** Takes any text and uses the first emoji in it. */
    setPastedEmoji(text: string): void
    setMonogram(text: string): void
    setIconQuery(query: string): void
    setImageQuery(query: string): void
    chooseImage(path: string): void
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
    let store = createStore<IdentitySnapshot>({
        label: "",
        mode: "monogram",
        iconTouched: false,
        iconName: defaultIcon,
        color: defaultColor,
        emoji: defaultEmoji,
        pastedEmoji: "",
        monogram: "",
        iconQuery: "",
        imageQuery: "",
    })
    let state = store.snapshot
    let update = (change: Partial<IdentitySnapshot>) => store.publish({ ...state(), ...change })
    let imagesFor: string | undefined

    function repository() {
        let id = state().repositoryId
        return workspace()?.repositories.find(candidate => candidate.id == id)
    }

    function identity(): RepositoryIdentity {
        let label = RepositoryLabelSchema.safeParse(state().label)
        let chosen = icon()
        return { ...label.success ? { label: label.data } : {}, ...chosen ? { icon: chosen } : {} }
    }

    function icon(): RepositoryIcon | undefined {
        let { iconTouched, mode, iconName, color, emoji, monogram } = state()
        if (!iconTouched)
            return undefined
        if (mode == "icon")
            return { kind: "icon", name: iconName, color }
        if (mode == "emoji")
            return { kind: "emoji", emoji }
        if (mode == "monogram") {
            // Letters that aren't valid yet keep the previous tile rather than showing a broken one.
            let text = monogramText(monogram)
            return text ? { kind: "monogram", text, color } : repository()?.icon
        }
        // Browsing to Image keeps whatever shows now until a file is chosen.
        return repository()?.icon
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

    // Scanned once per repository while the editor is open; a missing repository has nothing to scan.
    function loadImages(current: OpenRepository) {
        if (imagesFor == current.id)
            return
        imagesFor = current.id
        update({ images: undefined })
        let listed = (images: RepositoryImageFile[]) => {
            if (imagesFor == current.id)
                update({ images })
        }
        void api.listRepositoryImages(current.id).then(listed, () => listed([]))
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        open(repositoryId) {
            let current = workspace()?.repositories.find(candidate => candidate.id == repositoryId)
            if (!current)
                return
            let icon = current.icon
            let mode = icon?.kind ?? (automaticIcon(current) ? "image" : "monogram")
            imagesFor = undefined
            update({
                repositoryId,
                label: current.label ?? "",
                mode,
                iconTouched: icon != undefined,
                iconName: icon?.kind == "icon" ? icon.name : defaultIcon,
                color: icon?.kind == "icon" || icon?.kind == "monogram" ? icon.color : defaultColor,
                emoji: icon?.kind == "emoji" ? icon.emoji : defaultEmoji,
                pastedEmoji: "",
                monogram: icon?.kind == "monogram" ? icon.text : repositoryInitials(repositoryName(current)),
                iconQuery: "",
                images: undefined,
                imageQuery: "",
            })
            if (mode == "image")
                loadImages(current)
        },

        close() {
            update({ repositoryId: undefined })
        },

        setLabel(label) {
            apply({ label })
        },

        setMode(mode) {
            let current = repository()
            if (mode == "image" && current)
                loadImages(current)
            apply({ mode, iconTouched: true })
        },

        setIconName(iconName) {
            apply({ iconName, iconTouched: true })
        },

        setColor(color) {
            apply({ color, iconTouched: true })
        },

        setEmoji(emoji) {
            apply({ emoji, iconTouched: true })
        },

        setPastedEmoji(pastedEmoji) {
            let found = firstEmoji(pastedEmoji)
            apply({ pastedEmoji, iconTouched: true, ...found ? { emoji: found } : {} })
        },

        setMonogram(monogram) {
            apply({ monogram, iconTouched: true })
        },

        setIconQuery(iconQuery) {
            update({ iconQuery })
        },

        setImageQuery(imageQuery) {
            update({ imageQuery })
        },

        // A chosen file is read again, in case it changed since it was last shown.
        chooseImage(path) {
            let id = state().repositoryId
            if (!id)
                return
            forgetIconImage(path)
            update({ mode: "image", iconTouched: true })
            commit(id, { ...identity(), icon: { kind: "image", path } })
        },

        reset() {
            let current = repository()
            apply({ label: "", iconTouched: false, mode: current && automaticIcon(current) ? "image" : "monogram", color: defaultColor })
        },
    }
}

export let imageResultLimit = 40

/**
 * Image files matching a query, best first: every word must appear in the path, with matches at the
 * start of the file name ranked above matches elsewhere in the name, then matches in directories.
 */
export function searchImages(images: RepositoryImageFile[], query: string) {
    let words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (words.length == 0)
        return images.slice(0, imageResultLimit)
    return images
        .map(image => {
            let path = image.relative.toLocaleLowerCase()
            let name = path.split("/").pop()!
            if (!words.every(word => path.includes(word)))
                return undefined
            let score = words.reduce((total, word) => total + (name.startsWith(word) ? 3 : name.includes(word) ? 2 : 1), 0)
            return { image, score }
        })
        .filter(match => match != undefined)
        .sort((left, right) => right.score - left.score)
        .slice(0, imageResultLimit)
        .map(match => match.image)
}
