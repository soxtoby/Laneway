import { Autocomplete } from "react-aria-components"
import { refName } from "./comparison-columns"
import { type ComparisonPicker, pickerChoices } from "./comparison-picker"
import { DialogHeader } from "./dialog-header"
import { Dialog } from "./ui/Dialog"
import { Header, Menu, MenuItem, MenuSection } from "./ui/Menu"
import { Modal } from "./ui/Modal"
import { SearchField } from "./ui/SearchField"
import { useSnapshot } from "./use-snapshot"

export function ComparisonPickerDialog({ picker }: { picker: ComparisonPicker }) {
    let state = useSnapshot(picker)
    if (!state)
        return null
    let { workspace, repository, revision, more } = pickerChoices(state)
    let side = state.from ? "To" : "From"
    let sections = [{ title: "In this workspace", items: workspace }, { title: "Repository refs", items: repository }, {
        title: "Git revision",
        items: revision,
    }]
    return (
        <Modal isOpen isDismissable onOpenChange={open => open || picker.close()}>
            <Dialog aria-label="Compare refs" className="react-aria-Dialog command-lens">
                <DialogHeader>
                    <strong>{state.from ? refName(state.from) : "From"} → {state.to ? refName(state.to) : "To"}</strong>
                </DialogHeader>
                <Autocomplete key={side} inputValue={state.query} onInputChange={picker.search}>
                    <SearchField aria-label={side} placeholder={`${side} · Branch, tag, or commit`} autoFocus isReadOnly={state.busy} />
                    <Menu aria-label={`Choose ${side.toLowerCase()} ref`} className="react-aria-Menu lens-results">
                        {sections.filter(section => section.items.length).map(section => (
                            <MenuSection key={section.title} aria-label={section.title}>
                                <Header>{section.title}</Header>
                                {section.items.map(choice => (
                                    <MenuItem
                                        key={choice.id}
                                        id={choice.id}
                                        textValue={choice.label}
                                        onAction={() => void picker.choose(choice)}
                                    >
                                        <span className="lens-copy">
                                            <strong>{choice.label}</strong>
                                            <small>{choice.detail}</small>
                                        </span>
                                    </MenuItem>
                                ))}
                            </MenuSection>
                        ))}
                    </Menu>
                </Autocomplete>
                {!state.repository && <p role="status" className="lens-guidance">Reading refs…</p>}
                {more && <p className="lens-guidance">Showing the first 60 matching refs. Type to narrow the list.</p>}
                {state.error && <p role="alert">{state.error}</p>}
            </Dialog>
        </Modal>
    )
}
