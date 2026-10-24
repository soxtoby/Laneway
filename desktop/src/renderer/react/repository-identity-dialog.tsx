import type { OpenRepository, RepositoryIconColor } from "@laneway/shared"
import { monogramText, repositoryIconColors, repositoryInitials } from "@laneway/shared"
import type { ReactNode } from "react"
import { useReducer } from "react"
import { Autocomplete, type Key, ListBox, ListBoxItem, type Selection } from "react-aria-components"
import { Hint } from "./controls"
import { iconCatalog, iconLabel, searchIcons } from "./icon-catalog"
import { CatalogGlyph, EmojiTypeIcon, IconTypeIcon, ImageTypeIcon, MonogramTypeIcon } from "./icons"
import { automaticIcon, baseName, repositoryFolderName } from "./repositories"
import type { IconImageApi } from "./repository-icon-images"
import { emojiOptions, type IconMode, type IdentitySnapshot, type RepositoryIdentityEditor, searchImages } from "./repository-identity"
import { RepositoryTile } from "./repository-tile"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { SearchField } from "./ui/SearchField"
import { SegmentedControl, SegmentedControlItem } from "./ui/SegmentedControl"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

let modes: [IconMode, string, ReactNode][] = [["icon", "Icon", <IconTypeIcon key="icon" />], ["emoji", "Emoji", <EmojiTypeIcon key="emoji" />], [
    "monogram",
    "Monogram",
    <MonogramTypeIcon key="monogram" />,
], ["image", "Image", <ImageTypeIcon key="image" />]]

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
    return (
        <>
            <header className="identity-header">
                <RepositoryTile className="tile identity-preview" icon={repository.icon ?? automaticIcon(repository)} name={name} api={api} />
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
            <SegmentedControl
                aria-label="Icon type"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[state.mode]}
                onSelectionChange={keys => onlyKey(keys, key => editor.setMode(key as IconMode))}
            >
                {modes.map(([mode, label, icon]) => (
                    <SegmentedControlItem key={mode} id={mode}>
                        {icon}
                        {label}
                    </SegmentedControlItem>
                ))}
            </SegmentedControl>
            {(state.mode == "icon" || state.mode == "monogram") && <ColorPicker editor={editor} state={state} />}
            {state.mode == "icon" && <IconPicker editor={editor} state={state} />}
            {state.mode == "emoji" && <EmojiPicker editor={editor} state={state} />}
            {state.mode == "monogram" && <MonogramField editor={editor} state={state} folder={folder} api={api} />}
            {state.mode == "image" && <ImagePicker editor={editor} state={state} repository={repository} api={api} />}
            <div className="dialog-actions">
                <Button variant="secondary" onPress={editor.reset}>Reset</Button>
                <Button variant="accent" onPress={editor.close}>Done</Button>
            </div>
        </>
    )
}

// The default initials have no colour yet, so no swatch is chosen until one is.
function ColorPicker({ editor, state }: { editor: RepositoryIdentityEditor; state: IdentitySnapshot }) {
    return (
        <ListBox
            aria-label="Icon colour"
            className="picker-grid swatches"
            layout="grid"
            selectionMode="single"
            selectedKeys={state.iconTouched ? [state.color] : []}
            onSelectionChange={keys => onlyKey(keys, key => editor.setColor(key as RepositoryIconColor))}
        >
            {repositoryIconColors.map(color => (
                <ListBoxItem key={color} id={color} aria-label={colorLabel(color)} textValue={colorLabel(color)} className="picker-option">
                    <span className="swatch" data-tone={color} />
                </ListBoxItem>
            ))}
        </ListBox>
    )
}

function IconPicker({ editor, state }: { editor: RepositoryIdentityEditor; state: IdentitySnapshot }) {
    let [, loaded] = useReducer((count: number) => count + 1, 0)
    let catalog = iconCatalog(loaded)
    let results = catalog ? searchIcons(catalog, state.iconQuery) : []
    return (
        <>
            <SearchField aria-label="Search icons" placeholder="Search icons" value={state.iconQuery} onChange={editor.setIconQuery} />
            {!catalog
                ? <p className="picker-empty">Loading icons…</p>
                : results.length == 0
                ? <p className="picker-empty">No icons match.</p>
                : (
                    <ListBox
                        aria-label="Icons"
                        className="picker-grid"
                        layout="grid"
                        selectionMode="single"
                        selectedKeys={[state.iconName]}
                        onSelectionChange={keys => onlyKey(keys, key => editor.setIconName(String(key)))}
                    >
                        {results.map(iconName => (
                            <ListBoxItem
                                key={iconName}
                                id={iconName}
                                aria-label={iconLabel(iconName)}
                                textValue={iconLabel(iconName)}
                                className="picker-option"
                            >
                                <span className="picker-glyph" data-tone={state.color}>
                                    <CatalogGlyph node={catalog.nodes[iconName]!} />
                                </span>
                            </ListBoxItem>
                        ))}
                    </ListBox>
                )}
        </>
    )
}

function EmojiPicker({ editor, state }: { editor: RepositoryIdentityEditor; state: IdentitySnapshot }) {
    return (
        <>
            <ListBox
                aria-label="Emoji"
                className="picker-grid"
                layout="grid"
                selectionMode="single"
                selectedKeys={[state.emoji]}
                onSelectionChange={keys => onlyKey(keys, key => editor.setEmoji(String(key)))}
            >
                {emojiOptions.map(([emoji, label]) => (
                    <ListBoxItem key={emoji} id={emoji} aria-label={label} textValue={label} className="picker-option emoji-option">
                        {emoji}
                    </ListBoxItem>
                ))}
            </ListBox>
            <TextField aria-label="Any emoji" placeholder="Or paste any emoji" value={state.pastedEmoji} onChange={editor.setPastedEmoji} autoComplete="off" />
        </>
    )
}

function MonogramField({ editor, state, folder, api }: { editor: RepositoryIdentityEditor; state: IdentitySnapshot; folder: string; api: IconImageApi }) {
    let text = monogramText(state.monogram)
    return (
        <div className="monogram-row">
            <RepositoryTile
                className="tile identity-preview"
                icon={{ kind: "monogram", text: text ?? repositoryInitials(folder), color: state.iconTouched ? state.color : "gray" }}
                name={folder}
                api={api}
            />
            <TextField
                aria-label="Monogram letters"
                value={state.monogram}
                onChange={editor.setMonogram}
                maxLength={8}
                autoComplete="off"
                isInvalid={!text}
                description={state.iconTouched ? "One or two letters or numbers." : "The repository's initials until you choose something else."}
            />
        </div>
    )
}

// Like Command Lens results: typing stays in the search field while the arrow keys move through the
// files and Enter chooses one.
function ImagePicker(
    { editor, state, repository, api }: { editor: RepositoryIdentityEditor; state: IdentitySnapshot; repository: OpenRepository; api: IconImageApi },
) {
    let automatic = automaticIcon(repository)
    let current = repository.icon?.kind == "image" ? repository.icon.path : automatic?.path
    let results = state.images ? searchImages(state.images, state.imageQuery) : []
    let available = repository.status == "available"
    return (
        <>
            <Autocomplete inputValue={state.imageQuery} onInputChange={editor.setImageQuery}>
                <SearchField aria-label="Search images in the repository" placeholder="Search images in the repository" isDisabled={!available} />
                {!available
                    ? <p className="picker-empty">The repository is unavailable, so its images cannot be listed.</p>
                    : !state.images
                    ? <p className="picker-empty">Scanning for images…</p>
                    : results.length == 0
                    ? <p className="picker-empty">{state.images.length == 0 ? "No image files in the repository." : "No images match."}</p>
                    : (
                        <ListBox
                            aria-label="Images in the repository"
                            className="image-list"
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={current ? [current] : []}
                            onSelectionChange={keys => onlyKey(keys, key => editor.chooseImage(String(key)))}
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
            <p className="field-note">
                {repository.icon?.kind == "image"
                    ? `Using ${repository.icon.path}. `
                    : automatic
                    ? `Using the favicon ${baseName(automatic.path)} found in the repository. `
                    : ""}
                The file is read from where it is; moving it clears the icon.
            </p>
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

function colorLabel(color: RepositoryIconColor) {
    return color.charAt(0).toLocaleUpperCase() + color.slice(1)
}
