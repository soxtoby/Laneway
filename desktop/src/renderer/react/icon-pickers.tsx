import type { RepositoryIconColor } from "@laneway/shared"
import { graphemes, monogramText, repositoryIconColors } from "@laneway/shared"
import type { ReactNode } from "react"
import { useRef } from "react"
import { Autocomplete, type Key, ListBox, ListBoxItem, type Selection } from "react-aria-components"
import { iconLabel, searchIcons, useIconCatalog } from "./icon-catalog"
import { type IconChoice, type IconChooser, type IconMode, searchImages } from "./icon-choice"
import { CatalogGlyph, EmojiTypeIcon, IconTypeIcon, ImageTypeIcon, MonogramTypeIcon } from "./icons"
import { baseName } from "./repositories"
import type { IconImageApi } from "./repository-icon-images"
import { RepositoryTile } from "./repository-tile"
import { SearchField } from "./ui/SearchField"
import { SegmentedControl, SegmentedControlItem } from "./ui/SegmentedControl"
import { TextField } from "./ui/TextField"

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

let modes: [IconMode, string, ReactNode][] = [["icon", "Icon", <IconTypeIcon key="icon" />], ["emoji", "Emoji", <EmojiTypeIcon key="emoji" />], [
    "monogram",
    "Monogram",
    <MonogramTypeIcon key="monogram" />,
], ["image", "Image", <ImageTypeIcon key="image" />]]

interface IconFieldsProps {
    chooser: IconChooser
    choice: IconChoice
    /** The name's initials, which show until something else is chosen. */
    initials: string
    /** Whose initials they are, as the monogram field says. */
    owner: string
    /** The repository's image files: whether they can be listed, the one showing, and where it came from. */
    images: { available: boolean; current?: string; note: string }
    api: IconImageApi
}

/**
 * Choosing an icon the way a Repository Icon is chosen: a Tabler icon or a monogram in a colour, an emoji, or an image
 * file in the repository. The repository customization and script dialogs both show it.
 */
export function IconFields({ chooser, choice, initials, owner, images, api }: IconFieldsProps) {
    return (
        <>
            <SegmentedControl
                aria-label="Icon type"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[choice.mode]}
                onSelectionChange={keys => onlyKey(keys, key => chooser.setMode(key as IconMode))}
            >
                {modes.map(([mode, label, icon]) => (
                    <SegmentedControlItem key={mode} id={mode}>
                        {icon}
                        {label}
                    </SegmentedControlItem>
                ))}
            </SegmentedControl>
            <div className="identity-mode">
                {(choice.mode == "icon" || choice.mode == "monogram") && <ColorPicker chooser={chooser} choice={choice} />}
                {choice.mode == "icon" && <IconPicker chooser={chooser} choice={choice} />}
                {choice.mode == "emoji" && <EmojiPicker chooser={chooser} choice={choice} />}
                {choice.mode == "monogram" && <MonogramField chooser={chooser} choice={choice} initials={initials} owner={owner} api={api} />}
                {choice.mode == "image" && <ImagePicker chooser={chooser} choice={choice} images={images} api={api} />}
            </div>
        </>
    )
}

interface PickerProps {
    chooser: IconChooser
    choice: IconChoice
}

// The default initials have no colour yet, so no swatch is chosen until one is.
function ColorPicker({ chooser, choice }: PickerProps) {
    return (
        <ListBox
            aria-label="Icon colour"
            className="picker-grid swatches"
            layout="grid"
            selectionMode="single"
            selectedKeys={choice.iconTouched ? [choice.color] : []}
            onSelectionChange={keys => onlyKey(keys, key => chooser.setColor(key as RepositoryIconColor))}
        >
            {repositoryIconColors.map(color => (
                <ListBoxItem key={color} id={color} aria-label={colorLabel(color)} textValue={colorLabel(color)} className="picker-option">
                    <span className="swatch" data-tone={color} />
                </ListBoxItem>
            ))}
        </ListBox>
    )
}

function IconPicker({ chooser, choice }: PickerProps) {
    let catalog = useIconCatalog()
    let results = catalog ? searchIcons(catalog, choice.iconQuery) : []
    return (
        <>
            <SearchField aria-label="Search icons" placeholder="Search icons" value={choice.iconQuery} onChange={chooser.setIconQuery} />
            {!catalog
                ? <p className="picker-empty">Loading icons…</p>
                : results.length == 0
                ? <p className="picker-empty">No icons match.</p>
                : (
                    <ListBox
                        aria-label="Icons"
                        className="picker-grid icons"
                        layout="grid"
                        selectionMode="single"
                        selectedKeys={[choice.iconName]}
                        onSelectionChange={keys => onlyKey(keys, key => chooser.setIconName(String(key)))}
                    >
                        {results.map(iconName => (
                            <ListBoxItem
                                key={iconName}
                                id={iconName}
                                aria-label={iconLabel(iconName)}
                                textValue={iconLabel(iconName)}
                                className="picker-option"
                            >
                                <span className="picker-glyph" data-tone={choice.color}>
                                    <CatalogGlyph node={catalog.nodes[iconName]!} />
                                </span>
                            </ListBoxItem>
                        ))}
                    </ListBox>
                )}
        </>
    )
}

function EmojiPicker({ chooser, choice }: PickerProps) {
    return (
        <>
            <ListBox
                aria-label="Emoji"
                className="picker-grid"
                layout="grid"
                selectionMode="single"
                selectedKeys={[choice.emoji]}
                onSelectionChange={keys => onlyKey(keys, key => chooser.setEmoji(String(key)))}
            >
                {emojiOptions.map(([emoji, label]) => (
                    <ListBoxItem key={emoji} id={emoji} aria-label={label} textValue={label} className="picker-option emoji-option">
                        {emoji}
                    </ListBoxItem>
                ))}
            </ListBox>
            <TextField
                aria-label="Any emoji"
                placeholder="Or paste any emoji"
                value={choice.pastedEmoji}
                onChange={chooser.setPastedEmoji}
                autoComplete="off"
            />
        </>
    )
}

function MonogramField({ chooser, choice, initials, owner, api }: PickerProps & { initials: string; owner: string; api: IconImageApi }) {
    let text = monogramText(choice.monogram)
    // An input method's text is left whole while it is composed, since changing it would end the
    // composition, and is held to two letters once committed.
    let composedFrom = useRef<string>(undefined)
    let change = (kept: string) => {
        if (kept != choice.monogram)
            chooser.setMonogram(kept)
    }
    return (
        <div className="monogram-row">
            <RepositoryTile
                className="tile identity-preview"
                icon={{ kind: "monogram", text: text ?? initials, color: choice.iconTouched ? choice.color : "gray" }}
                name={initials}
                api={api}
            />
            <TextField
                aria-label="Monogram letters"
                value={choice.monogram}
                onChange={typed => change(composedFrom.current == undefined ? twoLetters(choice.monogram, typed) : typed)}
                onCompositionStart={() => {
                    composedFrom.current = choice.monogram
                }}
                onCompositionEnd={event => {
                    change(twoLetters(composedFrom.current ?? choice.monogram, event.currentTarget.value))
                    composedFrom.current = undefined
                }}
                autoComplete="off"
                spellCheck="false"
                isInvalid={choice.iconTouched && !text}
                description={choice.iconTouched ? "One or two letters or numbers." : `The ${owner}'s initials until you choose something else.`}
            />
        </div>
    )
}

// Like Command Lens results: typing stays in the search field while the arrow keys move through the
// files and Enter chooses one.
function ImagePicker({ chooser, choice, images, api }: PickerProps & Pick<IconFieldsProps, "images" | "api">) {
    let results = choice.images ? searchImages(choice.images, choice.imageQuery) : []
    return (
        <>
            <Autocomplete inputValue={choice.imageQuery} onInputChange={chooser.setImageQuery}>
                <SearchField aria-label="Search images in the repository" placeholder="Search images in the repository" isDisabled={!images.available} />
                {!images.available
                    ? <p className="picker-empty">The repository is unavailable, so its images cannot be listed.</p>
                    : !choice.images
                    ? <p className="picker-empty">Scanning for images…</p>
                    : results.length == 0
                    ? <p className="picker-empty">{choice.images.length == 0 ? "No image files in the repository." : "No images match."}</p>
                    : (
                        <ListBox
                            aria-label="Images in the repository"
                            className="image-list"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={images.current ? [images.current] : []}
                            onSelectionChange={keys => onlyKey(keys, key => chooser.chooseImage(String(key)))}
                        >
                            {results.map(image => (
                                <ListBoxItem key={image.path} id={image.path} textValue={image.relative} className="image-option">
                                    <RepositoryTile
                                        className="tile image-thumb"
                                        icon={{ kind: "image", path: image.path }}
                                        name={baseName(image.relative)}
                                        api={api}
                                    />
                                    <span className="image-copy">
                                        <span className="image-name">{baseName(image.relative)}</span>
                                        <span className="image-path">{image.relative}</span>
                                    </span>
                                </ListBoxItem>
                            ))}
                        </ListBox>
                    )}
            </Autocomplete>
            <p className="field-note">{images.note}</p>
        </>
    )
}

function onlyKey(keys: Selection, choose: (key: Key) => void) {
    if (keys != "all") {
        let [key] = keys
        if (key != undefined)
            choose(key)
    }
}

// A maximum length of two counted in letters rather than code units, so an accented or combined
// letter counts once. As with maxLength, what was typed or pasted is cut to the room left around it.
function twoLetters(previous: string, typed: string) {
    let after = graphemes(typed)
    if (after.length <= 2)
        return typed
    let before = graphemes(previous)
    let start = 0
    while (start < before.length && before[start] == after[start])
        start++
    let end = 0
    while (end < before.length - start && before.at(-1 - end) == after.at(-1 - end))
        end++
    let inserted = after.slice(start, after.length - end).slice(0, Math.max(0, 2 - start - end))
    return [...before.slice(0, start), ...inserted, ...before.slice(before.length - end)].join("")
}

function colorLabel(color: RepositoryIconColor) {
    return color.charAt(0).toLocaleUpperCase() + color.slice(1)
}
