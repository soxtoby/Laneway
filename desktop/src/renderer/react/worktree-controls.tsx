import type { BranchGraph, BranchGraphWorktree, WorktreeRequest } from "@laneway/shared"
import { useContext, useState } from "react"
import { Autocomplete, Button as AriaButton, useFilter } from "react-aria-components"
import type { ColumnView } from "./branch-workspace"
import { CommitAgesShown } from "./commit-age"
import { Hint } from "./controls"
import { EditableName } from "./editable-name"
import { MoreIcon } from "./icons"
import { Button } from "./ui/Button"
import { Text } from "./ui/Content"
import { Dialog, Heading } from "./ui/Dialog"
import { Menu, MenuItem, MenuSection, MenuTrigger, Separator } from "./ui/Menu"
import { Modal } from "./ui/Modal"
import { SearchField } from "./ui/SearchField"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

/** A worktree column's title: the worktree's name, renamed in place, over its path, marked when missing or locked. */
export function WorktreeTitle({ worktree, busy, onPrepare }: { worktree: BranchGraphWorktree; busy: boolean; onPrepare(request: WorktreeRequest): void }) {
    let fixed = worktree.main ? "Main worktree" : worktree.locked ? "Unlock worktree to rename" : worktree.missing ? "Locate worktree to rename" : undefined
    return (
        <div className="column-title">
            <div className="column-title-row">
                {/* A worktree that can't be renamed says why over its name. */}
                <Hint text={fixed} forControl>
                    <h2 className="column-name">
                        <EditableName
                            name={worktree.name}
                            label="worktree"
                            isDisabled={busy || fixed != undefined}
                            saveOnBlur
                            onCommit={basename => onPrepare({ action: "rename", path: worktree.path, basename })}
                        />
                    </h2>
                </Hint>
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
 * A worktree column's actions: switching its branch, unlocking, repairing, or removing it. A branch column
 * without a worktree offers checking the branch out instead, in an existing worktree or a new one. Either
 * ends with showing or hiding every commit row's age.
 */
export function WorktreeMenu({ column, graph, busy, onPrepare, chooseDirectory, onShowCommitAges }: WorktreeMenuProps) {
    let [choosing, setChoosing] = useState(false)
    let showCommitAges = useContext(CommitAgesShown)
    let worktree = column.worktree
    let worktrees = allWorktrees(graph)
    let branchRef = column.kind == "branch" ? column.branch.preferredRef : undefined
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
                    {worktree && !worktree.missing && (
                        <MenuItem aria-label="Switch worktree branch" onAction={() => setChoosing(true)}>
                            Switch branch…
                        </MenuItem>
                    )}
                    {!worktree && branchRef && worktrees.map(item => (
                        <MenuItem
                            key={item.path}
                            textValue={item.name}
                            isDisabled={item.missing}
                            onAction={() => onPrepare({ action: "switch", path: item.path, branch: branchRef, move: true })}
                        >
                            <Text slot="label">{`${item.name} · ${worktreeBranch(graph, item)}`}</Text>
                            <Text slot="description">{item.path}</Text>
                        </MenuItem>
                    ))}
                    {!worktree && branchRef && (
                        <MenuItem onAction={() => onPrepare({ action: "create", branch: branchRef, move: true })}>
                            New worktree
                        </MenuItem>
                    )}
                    {worktree && !worktree.main && worktree.locked && (
                        <MenuItem onAction={() => onPrepare({ action: "unlock", path: worktree.path })}>Unlock worktree</MenuItem>
                    )}
                    {worktree && !worktree.main && worktree.missing && <MenuItem onAction={() => void repair(worktree.path)}>Locate and repair</MenuItem>}
                    {worktree && !worktree.main && (
                        <MenuItem
                            isDisabled={worktree.locked}
                            onAction={() => onPrepare({ action: "remove", path: worktree.path, preserve: true, allowIgnoredLoss: false })}
                        >
                            {worktree.missing ? "Remove missing worktree" : "Remove worktree"}
                        </MenuItem>
                    )}
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
        </>
    )
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
                <Heading slot="title">Switch {worktree.name} to branch</Heading>
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
                    onPress={() => onPrepare({ action: "remove", path: worktree.path, preserve: true, allowIgnoredLoss: false })}
                >
                    Remove
                </Button>
            </div>
        </section>
    )
}

/** Every worktree in the repository, once each. */
function allWorktrees(graph: BranchGraph) {
    let worktrees = [...graph.branches.flatMap(branch => branch.checkedOut), ...graph.virtualBranches.map(branch => branch.worktree)]
    return worktrees.filter((item, index) => worktrees.findIndex(other => other.path == item.path) == index)
}

function worktreeBranch(graph: BranchGraph, worktree: BranchGraphWorktree) {
    return worktree.branchRef?.replace("refs/heads/", "")
        ?? graph.branches.find(branch => branch.checkedOut.some(item => item.path == worktree.path))?.name
        ?? "detached"
}
