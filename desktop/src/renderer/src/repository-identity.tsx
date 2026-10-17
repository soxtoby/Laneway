import type { OpenRepository, RepositoryIcon, RepositoryIconColor, RepositoryIdentity, RepositoryImageFile, Workspace } from "@laneway/shared"
import { firstEmoji, monogramText, repositoryInitials, RepositoryLabelSchema } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { Icon, LucideIcon } from "./icons"
import { iconLabel, lucideCatalog, searchLucide } from "./lucide-catalog"
import { automaticIcon, baseName, iconColorOptions, iconColorSwatches, iconTone, Monogram, repositoryFolderName, RepositoryIconContent, repositoryName } from "./repository-icon"
import { forgetIconImage } from "./repository-icon-images"

type IconMode = RepositoryIcon["kind"]

let defaultIcon = "folder-code"
let defaultEmoji = "💻"
// Neutral, so a monogram that starts from the default initials changes as little as possible.
let defaultColor: RepositoryIconColor = "gray"

// A starting set that covers most projects; any other emoji can be pasted.
let emojiOptions = [
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

export interface RepositoryIdentityEditor {
    open(repositoryId: string): void
    render(): RemixNode
}

interface EditorOptions {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    workspace(): Workspace
    /** Applies the identity at once; the dialog stays open for further changes. */
    commit(repositoryId: string, identity: RepositoryIdentity): void
}

/**
 * The repository customization dialog: a name and an icon that apply as they are chosen. Without an
 * override it opens on the tab the default came from, favicon or initials, and nothing is written
 * until an icon control is touched; Reset returns to that default.
 */
export function createRepositoryIdentityEditor(options: EditorOptions): RepositoryIdentityEditor {
    let dialog: HTMLDialogElement | undefined
    let repositoryId: string | undefined
    let mode: IconMode = "monogram"
    let iconTouched = false
    let label = ""
    let iconName = defaultIcon
    let color = defaultColor
    let emoji = defaultEmoji
    let monogram = ""
    let query = ""
    let pastedEmoji = ""
    let images: RepositoryImageFile[] | undefined
    let imagesFor: string | undefined
    let imageQuery = ""
    let imageIndex = 0

    return {
        open(id) {
            let repository = options.workspace().repositories.find(candidate => candidate.id == id)
            if (!repository)
                return
            repositoryId = id
            label = repository.label ?? ""
            let icon = repository.icon
            iconTouched = icon != undefined
            mode = icon?.kind ?? (automaticIcon(repository) ? "image" : "monogram")
            iconName = icon?.kind == "icon" ? icon.name : defaultIcon
            color = icon && icon.kind != "emoji" && icon.kind != "image" ? icon.color : defaultColor
            emoji = icon?.kind == "emoji" ? icon.emoji : defaultEmoji
            monogram = icon?.kind == "monogram" ? icon.text : repositoryInitials(repositoryName(repository))
            query = ""
            pastedEmoji = ""
            imageQuery = ""
            imageIndex = 0
            if (mode == "image")
                loadImages(repository)
            void options.update().then(() => dialog?.showModal())
        },
        render() {
            let repository = repositoryId ? options.workspace().repositories.find(candidate => candidate.id == repositoryId) : undefined
            if (!repository)
                return undefined
            return (
                <RepositoryIdentityDialog
                    api={options.api}
                    repository={repository}
                    dialogRef={node => dialog = node}
                    close={() => dialog?.close()}
                    closed={() => {
                        repositoryId = undefined
                        void options.update()
                    }}
                    label={label}
                    setLabel={value => {
                        label = value
                        apply()
                    }}
                    mode={mode}
                    setMode={next => {
                        mode = next
                        if (next == "image")
                            loadImages(repository)
                        touchIcon()
                    }}
                    iconName={iconName}
                    setIconName={name => {
                        iconName = name
                        touchIcon()
                    }}
                    color={color}
                    setColor={next => {
                        color = next
                        touchIcon()
                    }}
                    emoji={emoji}
                    setEmoji={next => {
                        emoji = next
                        touchIcon()
                    }}
                    pastedEmoji={pastedEmoji}
                    setPastedEmoji={value => {
                        pastedEmoji = value
                        let found = firstEmoji(value)
                        if (found)
                            emoji = found
                        touchIcon()
                    }}
                    monogram={monogram}
                    setMonogram={value => {
                        monogram = value
                        touchIcon()
                    }}
                    iconTouched={iconTouched}
                    query={query}
                    setQuery={value => {
                        query = value
                        void options.update()
                    }}
                    images={imagesFor == repository.id ? images : undefined}
                    imageQuery={imageQuery}
                    imageIndex={imageIndex}
                    setImageQuery={value => {
                        imageQuery = value
                        imageIndex = 0
                        void options.update()
                    }}
                    setImageIndex={index => {
                        imageIndex = index
                        void options.update()
                    }}
                    chooseImage={path => {
                        forgetIconImage(path)
                        mode = "image"
                        iconTouched = true
                        if (repositoryId)
                            options.commit(repositoryId, { ...identity(), icon: { kind: "image", path } })
                        void options.update()
                    }}
                    reset={() => {
                        label = ""
                        iconTouched = false
                        mode = automaticIcon(repository) ? "image" : "monogram"
                        color = defaultColor
                        apply()
                    }}
                />
            )
        },
    }

    function touchIcon() {
        iconTouched = true
        apply()
    }

    function apply() {
        if (repositoryId)
            options.commit(repositoryId, identity())
        // Untouched initials keep following the name as it is typed.
        let repository = options.workspace().repositories.find(candidate => candidate.id == repositoryId)
        if (!iconTouched && repository)
            monogram = repositoryInitials(repositoryName(repository))
        void options.update()
    }

    function identity(): RepositoryIdentity {
        let trimmed = RepositoryLabelSchema.safeParse(label)
        return { ...(trimmed.success ? { label: trimmed.data } : {}), ...(icon() ? { icon: icon() } : {}) }
    }

    function icon(): RepositoryIcon | undefined {
        let repository = options.workspace().repositories.find(candidate => candidate.id == repositoryId)
        if (!iconTouched)
            return undefined
        else if (mode == "icon")
            return { kind: "icon", name: iconName, color }
        else if (mode == "emoji")
            return { kind: "emoji", emoji }
        else if (mode == "monogram") {
            let text = monogramText(monogram)
            return text ? { kind: "monogram", text, color } : undefined
        } else {
            // Browsing to Image keeps whatever shows now until a file is chosen.
            return repository?.icon
        }
    }

    // Scanned once per repository while the dialog is open; a missing repository has nothing to scan.
    function loadImages(repository: OpenRepository) {
        if (imagesFor == repository.id)
            return
        imagesFor = repository.id
        images = undefined
        void options.api.listRepositoryImages(repository.id).then(found => {
            if (imagesFor == repository.id) {
                images = found
                void options.update()
            }
        }, () => {
            if (imagesFor == repository.id) {
                images = []
                void options.update()
            }
        })
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

let panel = css({
    padding: "0 14px 14px",
})

let header = css({
    margin: "0 -14px 14px",
    padding: "10px 14px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

let preview = css({
    width: "40px",
    height: "40px",
    flex: "0 0 auto",
    display: "grid",
    placeItems: "center",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "9px",
    background: "var(--control)",
    fontSize: "14px",
    fontWeight: "700",
    letterSpacing: "0.02em",
    overflow: "hidden",
    "& .image": { padding: "3px" },
})

let heading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

let folderPath = css({
    display: "block",
    margin: "2px 0 0",
    overflow: "hidden",
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "11px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let fieldLabel = css({
    display: "block",
    margin: "12px 0 5px",
})

let modes = css({
    display: "flex",
    gap: "4px",
    padding: "3px",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius)",
    background: "var(--panel-deep)",
    "& button": {
        flex: "1 1 0",
        minHeight: "26px",
        padding: "0 8px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "6px",
        color: "var(--muted)",
        border: "1px solid transparent",
        borderRadius: "4px",
        background: "transparent",
        fontSize: "12px",
        fontWeight: "500",
    },
    "& button:hover:not(:disabled)": { color: "var(--text)", background: "var(--control-hover)" },
    '& button[aria-pressed="true"]': { color: "var(--text)", borderColor: "var(--line-strong)", background: "var(--panel)", boxShadow: "var(--card-shadow)" },
})

let swatches = css({
    margin: "10px 0 0",
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    "& button": {
        width: "22px",
        height: "22px",
        padding: "0",
        display: "grid",
        placeItems: "center",
        border: "1px solid transparent",
        borderRadius: "50%",
        background: "transparent",
    },
    '& button[aria-pressed="true"]': { borderColor: "var(--text)" },
    "& button span": { width: "14px", height: "14px", borderRadius: "50%" },
})

let search = css({
    margin: "10px 0 0",
})

let grid = css({
    maxHeight: "232px",
    margin: "8px 0 0",
    padding: "2px",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(36px, 1fr))",
    gap: "2px",
    overflowY: "auto",
    "& button": {
        aspectRatio: "1",
        padding: "0",
        display: "grid",
        placeItems: "center",
        color: "var(--text)",
        border: "1px solid transparent",
        borderRadius: "5px",
        background: "transparent",
        fontSize: "20px",
        lineHeight: "1",
    },
    "& button:hover:not(:disabled)": { background: "var(--control-hover)" },
    '& button[aria-pressed="true"]': { borderColor: "var(--line-strong)", background: "var(--control)" },
})

let empty = css({
    margin: "16px 0",
    color: "var(--muted)",
    fontSize: "12px",
    textAlign: "center",
})

let note = css({
    margin: "8px 0 0",
    color: "var(--faint)",
    fontSize: "12px",
    lineHeight: "1.45",
    overflowWrap: "anywhere",
})

let monogramRow = css({
    margin: "10px 0 0",
    display: "grid",
    gridTemplateColumns: "48px minmax(0, 1fr)",
    alignItems: "center",
    gap: "12px",
})

let monogramPreview = css({
    width: "48px",
    height: "48px",
    display: "grid",
    placeItems: "center",
    border: "1px solid var(--line-strong)",
    borderRadius: "10px",
    background: "var(--control)",
    "& svg": { width: "100%", height: "100%", fontFamily: "var(--mono)" },
})

// Image files list like Command Lens results: a thumbnail, the file name, and where it lives.
let imageList = css({
    maxHeight: "232px",
    margin: "8px 0 0",
    padding: "2px",
    overflowY: "auto",
    "& button": {
        width: "100%",
        minHeight: "38px",
        padding: "4px 8px 4px 4px",
        display: "grid",
        gridTemplateColumns: "30px minmax(0, 1fr)",
        alignItems: "center",
        gap: "9px",
        color: "var(--text)",
        textAlign: "left",
        border: "1px solid transparent",
        borderRadius: "4px",
        background: "transparent",
    },
    "& button:hover": { background: "var(--control-hover)" },
    '& button[data-highlighted="true"]': { borderColor: "var(--accent-edge)", background: "var(--accent-wash-strong)" },
    '& button[aria-pressed="true"] .image-name': { color: "var(--accent)" },
    "& .image-thumb": {
        width: "30px",
        height: "30px",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        border: "1px solid var(--line)",
        borderRadius: "5px",
        background: "var(--control)",
        fontSize: "10px",
        fontWeight: "700",
    },
    "& .image-thumb .image": { padding: "2px" },
    "& .image-copy": { minWidth: "0", display: "grid", gap: "1px" },
    "& .image-name": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" },
    "& .image-path": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--faint)", fontFamily: "var(--mono)", fontSize: "10px" },
})

let dialogActions = css({
    marginLeft: "-14px",
    marginRight: "-14px",
    marginBottom: "-14px",
    justifyContent: "space-between",
})

let modeLabels: Record<IconMode, [string, "image" | "emoji" | "type" | "image-plus"]> = {
    icon: ["Icon", "image"],
    emoji: ["Emoji", "emoji"],
    monogram: ["Monogram", "type"],
    image: ["Image", "image-plus"],
}

function RepositoryIdentityDialog(
    handle: Handle<{
        api: Window["laneway"]
        repository: OpenRepository
        dialogRef(node: HTMLDialogElement): void
        close(): void
        closed(): void
        label: string
        setLabel(value: string): void
        mode: IconMode
        setMode(mode: IconMode): void
        iconName: string
        setIconName(name: string): void
        color: RepositoryIconColor
        setColor(color: RepositoryIconColor): void
        emoji: string
        setEmoji(emoji: string): void
        pastedEmoji: string
        setPastedEmoji(value: string): void
        monogram: string
        setMonogram(value: string): void
        query: string
        setQuery(value: string): void
        /** Undefined while the repository is still being scanned. */
        images?: RepositoryImageFile[]
        imageQuery: string
        /** The keyboard-highlighted row among the current results. */
        imageIndex: number
        setImageQuery(value: string): void
        setImageIndex(index: number): void
        chooseImage(path: string): void
        /** False while the icon is still the default, so the tab shows what was inferred rather than a choice. */
        iconTouched: boolean
        reset(): void
    }>,
) {
    let refresh = () => void handle.update()
    return () => {
        let props = handle.props
        let repository = props.repository
        let folder = repositoryFolderName(repository)
        let name = props.label.trim() || folder
        let catalog = lucideCatalog(refresh)
        let results = catalog ? searchLucide(catalog, props.query) : []
        let monogram = monogramText(props.monogram)
        let automatic = automaticIcon(repository)
        let imageResults = props.images ? searchImages(props.images, props.imageQuery) : []
        let currentImage = repository.icon?.kind == "image" ? repository.icon.path : automatic?.path
        return (
            <dialog aria-labelledby="repository-identity-heading" mix={[ref(props.dialogRef), on("close", props.closed)]}>
                <section class="repository-identity" mix={panel}>
                    <header mix={header}>
                        <span class="repository-tile-preview" mix={preview}>
                            <RepositoryIconContent icon={repository.icon ?? automatic} name={name} size={40} api={props.api} />
                        </span>
                        <div style={{ minWidth: "0" }}>
                            <h2 id="repository-identity-heading" mix={heading}>{name}</h2>
                            <small title={repository.path} mix={folderPath}>{repository.path}</small>
                        </div>
                    </header>
                    <label for="repository-label" mix={fieldLabel}>Name</label>
                    <input
                        id="repository-label"
                        value={props.label}
                        placeholder={folder}
                        maxLength={120}
                        autocomplete="off"
                        mix={[on("input", event => props.setLabel(event.currentTarget.value))]}
                    />
                    <p class="field-note">Only the label in Laneway changes; the folder keeps its name.</p>
                    <span class="eyebrow" mix={fieldLabel}>Icon</span>
                    <div role="group" aria-label="Icon type" mix={modes}>
                        {(Object.keys(modeLabels) as IconMode[]).map(mode => (
                            <button
                                type="button"
                                aria-pressed={props.mode == mode}
                                mix={on("click", () => props.setMode(mode))}
                            >
                                <Icon name={modeLabels[mode][1]} size={13} />
                                {modeLabels[mode][0]}
                            </button>
                        ))}
                    </div>
                    {(props.mode == "icon" || props.mode == "monogram") && (
                        <div role="group" aria-label="Icon colour" mix={swatches}>
                            {iconColorOptions.map(option => (
                                <button
                                    type="button"
                                    aria-label={option.label}
                                    title={option.label}
                                    // The default initials have no colour yet, so no swatch is pressed until one is chosen.
                                    aria-pressed={props.iconTouched && props.color == option.value}
                                    mix={on("click", () => props.setColor(option.value))}
                                >
                                    <span style={{ background: iconColorSwatches[option.value] }} />
                                </button>
                            ))}
                        </div>
                    )}
                    {props.mode == "icon" && (
                        <>
                            <input
                                type="search"
                                aria-label="Search icons"
                                placeholder="Search icons"
                                value={props.query}
                                autocomplete="off"
                                mix={[search, on("input", event => props.setQuery(event.currentTarget.value))]}
                            />
                            {catalog && results.length > 0 && (
                                <div role="group" aria-label="Icons" mix={grid}>
                                    {results.map(iconName => (
                                        <button
                                            key={iconName}
                                            type="button"
                                            aria-label={iconLabel(iconName)}
                                            title={iconLabel(iconName)}
                                            aria-pressed={props.iconName == iconName}
                                            style={{ color: iconTone(props.color) }}
                                            mix={on("click", () => props.setIconName(iconName))}
                                        >
                                            <LucideIcon node={catalog.nodes[iconName]} size={18} />
                                        </button>
                                    ))}
                                </div>
                            )}
                            {catalog && results.length == 0 && <p mix={empty}>No icons match.</p>}
                            {!catalog && <p mix={empty}>Loading icons…</p>}
                        </>
                    )}
                    {props.mode == "emoji" && (
                        <>
                            <div role="group" aria-label="Emoji" mix={grid}>
                                {emojiOptions.map(([option, label]) => (
                                    <button
                                        key={option}
                                        type="button"
                                        aria-label={label}
                                        title={label}
                                        aria-pressed={props.emoji == option}
                                        mix={on("click", () => props.setEmoji(option))}
                                    >
                                        {option}
                                    </button>
                                ))}
                            </div>
                            <input
                                aria-label="Any emoji"
                                placeholder="Or paste any emoji"
                                value={props.pastedEmoji}
                                autocomplete="off"
                                mix={[search, on("input", event => props.setPastedEmoji(event.currentTarget.value))]}
                            />
                        </>
                    )}
                    {props.mode == "monogram" && (
                        <div mix={monogramRow}>
                            <span style={{ color: props.iconTouched ? iconTone(props.color) : "" }} mix={monogramPreview}>
                                <Monogram text={monogram ?? repositoryInitials(folder)} />
                            </span>
                            <div>
                                <input
                                    aria-label="Monogram letters"
                                    aria-invalid={!monogram}
                                    value={props.monogram}
                                    maxLength={8}
                                    autocomplete="off"
                                    mix={[on("input", event => props.setMonogram(event.currentTarget.value))]}
                                />
                                <p class="field-note">
                                    {props.iconTouched ? "One or two letters or numbers." : "The repository's initials until you choose something else."}
                                </p>
                            </div>
                        </div>
                    )}
                    {props.mode == "image" && (
                        <>
                            <input
                                type="search"
                                aria-label="Search images in the repository"
                                placeholder="Search images in the repository"
                                value={props.imageQuery}
                                autocomplete="off"
                                disabled={repository.status != "available"}
                                mix={[
                                    search,
                                    on("input", event => props.setImageQuery(event.currentTarget.value)),
                                    on("keydown", event => {
                                        if (event.key == "ArrowDown" || event.key == "ArrowUp") {
                                            event.preventDefault()
                                            let count = imageResults.length
                                            if (count)
                                                props.setImageIndex((props.imageIndex + (event.key == "ArrowDown" ? 1 : count - 1)) % count)
                                        } else if (event.key == "Enter" && imageResults[props.imageIndex]) {
                                            event.preventDefault()
                                            props.chooseImage(imageResults[props.imageIndex].path)
                                        }
                                    }),
                                ]}
                            />
                            {repository.status != "available"
                                ? <p mix={empty}>The repository is unavailable, so its images cannot be listed.</p>
                                : !props.images
                                ? <p mix={empty}>Scanning for images…</p>
                                : imageResults.length == 0
                                ? <p mix={empty}>{props.images.length == 0 ? "No image files in the repository." : "No images match."}</p>
                                : (
                                    <div role="listbox" aria-label="Images in the repository" mix={imageList}>
                                        {imageResults.map((image, index) => (
                                            <button
                                                key={image.path}
                                                type="button"
                                                role="option"
                                                aria-selected={index == props.imageIndex}
                                                aria-pressed={image.path == currentImage}
                                                data-highlighted={index == props.imageIndex}
                                                title={image.path}
                                                mix={[on("click", () => props.chooseImage(image.path)), on("pointerenter", () => props.setImageIndex(index))]}
                                            >
                                                <span class="image-thumb">
                                                    <RepositoryIconContent
                                                        icon={{ kind: "image", path: image.path }}
                                                        name={baseName(image.relative)}
                                                        size={30}
                                                        api={props.api}
                                                    />
                                                </span>
                                                <span class="image-copy">
                                                    <span class="image-name">{baseName(image.relative)}</span>
                                                    <span class="image-path">{image.relative}</span>
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            <p mix={note}>
                                {repository.icon?.kind == "image"
                                    ? `Using ${repository.icon.path}. `
                                    : automatic
                                    ? `Using the favicon ${baseName(automatic.path)} found in the repository. `
                                    : ""}
                                The file is read from where it is; moving it clears the icon.
                            </p>
                        </>
                    )}
                    <footer class="dialog-actions" mix={dialogActions}>
                        <button class="text-button" type="button" mix={[on("click", props.reset)]}>Reset</button>
                        <button class="primary-button" type="button" mix={[on("click", props.close)]}>Done</button>
                    </footer>
                </section>
            </dialog>
        )
    }
}
