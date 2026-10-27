import type { RepositoryIcon, RepositoryIconColor, RepositoryImageFile } from "@laneway/shared"
import { firstEmoji, monogramText } from "@laneway/shared"
import { forgetIconImage } from "./repository-icon-images"

export type IconMode = RepositoryIcon["kind"]

let defaultIcon = "folder-code"
let defaultEmoji = "💻"
// Neutral, so a monogram that starts from the default initials changes as little as possible.
let defaultColor: RepositoryIconColor = "gray"

/** The icon controls' state, which the repository customization and script dialogs share. */
export interface IconChoice {
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
    /** The image file chosen, which stays chosen while another tab shows. */
    imagePath?: string
    /** The repository's image files; absent while they are scanned. */
    images?: RepositoryImageFile[]
    imageQuery: string
}

/** What the icon controls change. */
export interface IconChooser {
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
}

/** The controls showing `icon`, or showing `initials` on the `untouched` tab while there is none. */
export function iconChoice(icon: RepositoryIcon | undefined, untouched: IconMode, initials: string): IconChoice {
    return {
        mode: icon?.kind ?? untouched,
        iconTouched: icon != undefined,
        iconName: icon?.kind == "icon" ? icon.name : defaultIcon,
        color: icon?.kind == "icon" || icon?.kind == "monogram" ? icon.color : defaultColor,
        emoji: icon?.kind == "emoji" ? icon.emoji : defaultEmoji,
        pastedEmoji: "",
        monogram: icon?.kind == "monogram" ? icon.text : initials,
        iconQuery: "",
        imagePath: icon?.kind == "image" ? icon.path : undefined,
        images: undefined,
        imageQuery: "",
    }
}

/**
 * The icon the controls choose, or nothing while they are untouched. Letters that aren't valid yet keep `previous`
 * rather than showing a broken tile, as browsing to Image does until a file is chosen.
 */
export function chosenIcon(choice: IconChoice, previous?: RepositoryIcon): RepositoryIcon | undefined {
    let { iconTouched, mode, iconName, color, emoji, monogram, imagePath } = choice
    if (!iconTouched)
        return undefined
    if (mode == "icon")
        return { kind: "icon", name: iconName, color }
    if (mode == "emoji")
        return { kind: "emoji", emoji }
    if (mode == "monogram") {
        let text = monogramText(monogram)
        return text ? { kind: "monogram", text, color } : previous
    }
    return imagePath ? { kind: "image", path: imagePath } : previous
}

/**
 * The icon controls' changes: choices go through `apply`, which may save them, and searches through `update`, as they
 * choose nothing. Showing Image scans the repository for its files.
 */
export function iconChooser(
    { apply, update, scanImages }: { apply(change: Partial<IconChoice>): void; update(change: Partial<IconChoice>): void; scanImages(): void },
): IconChooser {
    return {
        setMode(mode) {
            if (mode == "image")
                scanImages()
            apply({ mode, iconTouched: true })
        },
        setIconName: iconName => apply({ iconName, iconTouched: true }),
        setColor: color => apply({ color, iconTouched: true }),
        setEmoji: emoji => apply({ emoji, iconTouched: true }),
        setPastedEmoji(pastedEmoji) {
            let found = firstEmoji(pastedEmoji)
            apply({ pastedEmoji, iconTouched: true, ...found ? { emoji: found } : {} })
        },
        setMonogram: monogram => apply({ monogram, iconTouched: true }),
        setIconQuery: iconQuery => update({ iconQuery }),
        setImageQuery: imageQuery => update({ imageQuery }),
        // A chosen file is read again, in case it changed since it was last shown.
        chooseImage(imagePath) {
            forgetIconImage(imagePath)
            apply({ mode: "image", imagePath, iconTouched: true })
        },
    }
}

/** Lists a repository's image files once while a dialog shows it; a missing repository lists none. */
export function imageScanner(api: Pick<Window["laneway"], "listRepositoryImages">, update: (change: { images?: RepositoryImageFile[] }) => void) {
    let scanned: string | undefined
    return {
        scan(repositoryId: string) {
            if (scanned == repositoryId)
                return
            scanned = repositoryId
            update({ images: undefined })
            let listed = (images: RepositoryImageFile[]) => {
                if (scanned == repositoryId)
                    update({ images })
            }
            void api.listRepositoryImages(repositoryId).then(listed, () => listed([]))
        },
        reset() {
            scanned = undefined
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
