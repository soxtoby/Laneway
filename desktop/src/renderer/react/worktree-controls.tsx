import type { BranchGraph, BranchGraphBranchNode, BranchGraphWorktree, WorktreeRequest } from "@laneway/shared"
import { useContext, useState } from "react"
import { Autocomplete, Button as AriaButton, useFilter } from "react-aria-components"
import type { ColumnView } from "./branch-workspace"
import { CommitAgesShown } from "./commit-age"
import { Hint, SplitMenuItem } from "./controls"
import { DialogHeader } from "./dialog-header"
import { copyText } from "./file-paths"
import { MoreIcon } from "./icons"
import { Button } from "./ui/Button"
import { Text } from "./ui/Content"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Menu, MenuItem, MenuSection, MenuTrigger, Separator } from "./ui/Menu"
import { Modal } from "./ui/Modal"
import { SearchField } from "./ui/SearchField"
import { TextField } from "./ui/TextField"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { checkoutWorktrees, worktreeLabel } from "./worktree-columns"

/** A worktree column's title: the column's name over the worktree's path, marked when missing or locked. */
export function WorktreeTitle({ name, worktree }: { name: string; worktree: BranchGraphWorktree }) {
    return (
        <div className="column-title">
            <div className="column-title-row">
                <h2 className="column-name">{name}</h2>
                {worktree.missing && <span className="state-chip">Missing</span>}
                {worktree.locked && (
                    <Hint text={worktree.lockReason ?? "Locked"}>
                        <span className="state-chip">Locked</span>
                    </Hint>
                )}
            </div>
            <Hint text={worktree.path}>
                <span className="column-path">{worktree.path}</span>
            </Hint>
        </div>
    )
}

interface WorktreeMenuProps {
    column: Extract<ColumnView, { kind: "branch" | "virtual" }>
    graph: BranchGraph
    busy: boolean
    onPrepare(request: WorktreeRequest): void
    chooseDirectory(path?: string): Promise<string | undefined>
    onShowCommitAges(shown: boolean): void
}

/**
 * A worktree column's actions: switching its branch, renaming, unlocking, repairing, or removing it. A branch column
 * without a worktree offers checking the branch out instead, in an existing worktree or a new one. Either
 * ends with copying the branch name and worktree path, then showing or hiding every commit row's age. A
 * worktree in a Historical Edit neither switches branch nor goes away until it returns.
 */
export function WorktreeMenu({ column, graph, busy, onPrepare, chooseDirectory, onShowCommitAges }: WorktreeMenuProps) {
    let [choosing, setChoosing] = useState(false)
    let [renaming, setRenaming] = useState(false)
    let showCommitAges = useContext(CommitAgesShown)
    let worktree = column.worktree
    let editing = worktree?.historicalEdit != undefined
    let repair = async (path: string) => {
        let destination = await chooseDirectory(path)
        if (destination)
            onPrepare({ action: "repair", path, destination })
    }
    return (
        <>
            <MenuTrigger>
                <TooltipTrigger>
                    <AriaButton className="icon-button" aria-label={worktree ? "Worktree actions" : "Check out branch"} isDisabled={busy}>
                        <MoreIcon />
                    </AriaButton>
                    <Tooltip>{worktree ? "Worktree actions" : "Check out branch"}</Tooltip>
                </TooltipTrigger>
                <Menu aria-label={worktree ? "Worktree actions" : "Check out branch"}>
                    {worktree && !worktree.missing && !editing && (
                        <MenuItem aria-label="Switch worktree branch" onAction={() => setChoosing(true)}>
                            Switch branch…
                        </MenuItem>
                    )}
                    {/* The Main Worktree never moves; a locked or missing one is unlocked or located first, just below. */}
                    {worktree && !worktree.main && (
                        <MenuItem isDisabled={worktree.locked || worktree.missing} onAction={() => setRenaming(true)}>
                            Rename worktree…
                        </MenuItem>
                    )}
                    {!worktree && column.kind == "branch" && <CheckoutItems graph={graph} branch={column.branch} onPrepare={onPrepare} />}
                    {worktree && !worktree.main && worktree.locked && (
                        <MenuItem onAction={() => onPrepare({ action: "unlock", path: worktree.path })}>Unlock worktree</MenuItem>
                    )}
                    {worktree && !worktree.main && worktree.missing && <MenuItem onAction={() => void repair(worktree.path)}>Locate and repair</MenuItem>}
                    {worktree && !worktree.main && !editing && (
                        <MenuItem
                            isDisabled={worktree.locked}
                            onAction={() => onPrepare({ action: "remove", path: worktree.path, preserve: true })}
                        >
                            {worktree.missing ? "Remove missing worktree" : "Remove worktree"}
                        </MenuItem>
                    )}
                    <Separator />
                    {column.kind == "branch" && <MenuItem onAction={() => void copyText(column.branch.name)}>Copy branch name</MenuItem>}
                    {worktree && <MenuItem onAction={() => void copyText(worktree.path)}>Copy worktree path</MenuItem>}
                    <Separator />
                    <MenuSection
                        selectionMode="multiple"
                        selectedKeys={showCommitAges ? ["commit-ages"] : []}
                        onSelectionChange={keys => onShowCommitAges(keys == "all" || keys.has("commit-ages"))}
                    >
                        <MenuItem id="commit-ages">Show commit ages</MenuItem>
                    </MenuSection>
                </Menu>
            </MenuTrigger>
            {worktree && (
                <BranchChooser
                    worktree={worktree}
                    graph={graph}
                    isOpen={choosing}
                    onClose={() => setChoosing(false)}
                    onChoose={branch => {
                        setChoosing(false)
                        onPrepare({ action: "switch", path: worktree.path, branch, move: true })
                    }}
                />
            )}
            {worktree && (
                <WorktreeRename
                    worktree={worktree}
                    isOpen={renaming}
                    onClose={() => setRenaming(false)}
                    onRename={basename => {
                        setRenaming(false)
                        onPrepare({ action: "rename", path: worktree.path, basename })
                    }}
                />
            )}
        </>
    )
}

/** Asks for a worktree directory's new name; the rename is then reviewed like any other worktree operation. */
function WorktreeRename({ worktree, isOpen, onClose, onRename }: {
    worktree: BranchGraphWorktree
    isOpen: boolean
    onClose(): void
    onRename(basename: string): void
}) {
    let [name, setName] = useState(worktree.name)
    // Each opening starts from the worktree's current name.
    let [opened, setOpened] = useState(isOpen)
    if (isOpen != opened) {
        setOpened(isOpen)
        if (isOpen)
            setName(worktree.name)
    }
    let next = name.trim()
    return (
        <Modal isOpen={isOpen} isDismissable onOpenChange={open => open || onClose()}>
            <Dialog className="react-aria-Dialog worktree-dialog">
                <Form
                    className="react-aria-Form entry-form"
                    onSubmit={event => {
                        event.preventDefault()
                        if (next && next != worktree.name)
                            onRename(next)
                    }}
                >
                    <DialogHeader>
                        <Heading slot="title">Rename worktree</Heading>
                    </DialogHeader>
                    <TextField
                        label="Directory name"
                        description={worktree.path}
                        value={name}
                        onChange={setName}
                        autoComplete="off"
                        spellCheck="false"
                        autoFocus
                    />
                    <div className="dialog-actions">
                        <Button variant="secondary" onPress={onClose}>Cancel</Button>
                        <Button type="submit" variant="accent" isDisabled={!next || next == worktree.name}>Rename</Button>
                    </div>
                </Form>
            </Dialog>
        </Modal>
    )
}

interface CheckoutProps {
    graph: BranchGraph
    branch: BranchGraphBranchNode
    onPrepare(request: WorktreeRequest): void
}

/** The graph checks local branches out by name and remote-only branches detached at their displayed tip. */
export function GraphCheckout({ graph, branch, onPrepare }: CheckoutProps) {
    let detached = branch.remoteOnly
    let label = detached ? "Check out detached" : "Check out"
    let main = checkoutWorktrees(graph).find(worktree => worktree.main && !worktree.missing)
    return (
        <SplitMenuItem
            label={label}
            moreLabel={`${label} in`}
            isDisabled={!main || (detached ? detachedAt(main, branch.tip) : branch.checkedOut.length > 0)}
            onAction={() => {
                if (main)
                    onPrepare({ action: "switch", path: main.path, ...checkoutTarget(branch, detached) })
            }}
        >
            <Menu aria-label={`${label} ${branch.name} in`}>
                <CheckoutItems graph={graph} branch={branch} detached={detached} onPrepare={onPrepare} />
            </Menu>
        </SplitMenuItem>
    )
}

function CheckoutItems({ graph, branch, detached = false, onPrepare }: CheckoutProps & { detached?: boolean }) {
    let target = checkoutTarget(branch, detached)
    return (
        <>
            {checkoutWorktrees(graph).map(item => (
                <MenuItem
                    key={item.path}
                    textValue={item.name}
                    isDisabled={item.missing || (detached ? detachedAt(item, branch.tip) : branch.checkedOut.some(holder => holder.path == item.path))}
                    onAction={() => onPrepare({ action: "switch", path: item.path, ...target })}
                >
                    <Text slot="label">{worktreeLabel(graph, item)}</Text>
                    <Text slot="description">{item.path}</Text>
                </MenuItem>
            ))}
            <Separator />
            <MenuItem onAction={() => onPrepare({ action: "create", ...target })}>New worktree</MenuItem>
        </>
    )
}

function checkoutTarget(branch: BranchGraphBranchNode, detached: boolean) {
    return detached ? { commit: branch.tip, move: false } : { branch: branch.preferredRef, move: true }
}

function detachedAt(worktree: BranchGraphWorktree, commit: string) {
    return !worktree.branchRef && worktree.head == commit
}

/** Finds a local branch to switch a worktree to, by typing part of its name. */
function BranchChooser({ worktree, graph, isOpen, onClose, onChoose }: {
    worktree: BranchGraphWorktree
    graph: BranchGraph
    isOpen: boolean
    onClose(): void
    onChoose(branchRef: string): void
}) {
    let { contains } = useFilter({ sensitivity: "base" })
    let branches = graph.branches.filter(branch => branch.localRefs.length > 0 && !branch.checkedOut.some(item => item.path == worktree.path))
    return (
        <Modal isOpen={isOpen} isDismissable onOpenChange={open => open || onClose()}>
            <Dialog className="react-aria-Dialog branch-chooser">
                <DialogHeader>
                    <Heading slot="title">Switch {worktree.name} to branch</Heading>
                </DialogHeader>
                <Autocomplete filter={contains}>
                    <SearchField aria-label="Search branches" placeholder="Search branches" autoFocus />
                    <Menu
                        aria-label="Branches"
                        className="react-aria-Menu branch-results"
                        items={branches}
                        onAction={key => onChoose(String(key))}
                        renderEmptyState={() => <p className="picker-empty">No branches match.</p>}
                    >
                        {branch => <MenuItem id={branch.localRefs[0]} textValue={branch.name}>{branch.name}</MenuItem>}
                    </Menu>
                </Autocomplete>
            </Dialog>
        </Modal>
    )
}

/** A worktree whose directory is gone: locate the directory again, or remove the worktree's registration. */
export function MissingWorktree({ worktree, busy, onPrepare, chooseDirectory }: {
    worktree: BranchGraphWorktree
    busy: boolean
    onPrepare(request: WorktreeRequest): void
    chooseDirectory(path?: string): Promise<string | undefined>
}) {
    let repair = async () => {
        let destination = await chooseDirectory(worktree.path)
        if (destination)
            onPrepare({ action: "repair", path: worktree.path, destination })
    }
    return (
        <section className="missing-worktree" aria-label="Missing worktree">
            <h3>Worktree directory missing</h3>
            <p>Locate the directory to repair this worktree, or remove its registration.</p>
            <div className="recovery-actions">
                <Button variant="accent" isDisabled={busy} onPress={() => void repair()}>Repair</Button>
                <Button
                    variant="secondary"
                    isDisabled={busy || worktree.locked}
                    onPress={() => onPrepare({ action: "remove", path: worktree.path, preserve: true })}
                >
                    Remove
                </Button>
            </div>
        </section>
    )
}
