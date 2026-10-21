import type { BranchGraphWorktree } from "@laneway/shared"
import { useState } from "react"
import { FormError } from "./form-error"
import type { HistoricalEdits } from "./historical-edit"
import { ModifiedIcon } from "./icons"
import { TransferReview, useTransferScope } from "./transfer"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { useSnapshot } from "./use-snapshot"

type Session = NonNullable<BranchGraphWorktree["historicalEdit"]>

/**
 * A column in Historical Edit names the commit it edits and the branch it came from, and offers the way back.
 * A paused session waits for its conflicts, which resolve in the Commit Trail below; a stale one offers to restart.
 */
export function HistoricalEditBanner({ edits, repositoryId, edit, count }: {
    edits: HistoricalEdits
    repositoryId: string
    edit: Session
    /** How many Historical Working Changes remain, once they are read. */
    count?: number
}) {
    let { busy } = useSnapshot(edits)
    let scope = useTransferScope()
    let branch = branchName(edit)
    let returning = () => void edits.return({ repositoryId, path: edit.path, branch, count: count ?? 0 })
    return (
        <section className="historical-edit" aria-label="Historical Edit" data-state={edit.state}>
            <p className="historical-edit-title">
                <ModifiedIcon />
                <span>
                    Editing from <strong>{edit.subject}</strong> on <strong>{branch}</strong>
                </span>
            </p>
            {edit.state == "active" && (
                <p>Apply changes rewrites this commit and restacks what is built on it. Your earlier Working Changes wait until you return.</p>
            )}
            {edit.state != "active" && <p role={edit.state == "stale" ? "alert" : "status"}>{edit.reason}</p>}
            <div className="historical-edit-actions">
                {edit.state == "stale" && (
                    <Button variant="secondary" isDisabled={busy} onPress={() => void edits.restart(repositoryId, edit.path)}>Restart on latest</Button>
                )}
                <Button variant="secondary" isDisabled={busy || edit.state == "paused" || count == undefined} onPress={returning}>
                    Return to {branch}
                </Button>
            </div>
            {/* Apply lands on the edited commit, wherever the Commit Trail shows it, so its review shows here. */}
            {scope && <TransferReview composition={scope.composition} repositoryId={repositoryId} target={applyTarget(edit)} />}
        </section>
    )
}

/** Where Apply changes lands: the edited commit, as it is on its original branch. */
export function applyTarget(edit: Session) {
    return { kind: "commit" as const, objectId: edit.commit, branch: edit.branch }
}

function branchName(edit: Session) {
    return edit.branch.replace(/^refs\/heads\//, "")
}

/** The choice a return with Historical Working Changes left waits for; Cancel stays in the session. */
export function ReturnDialog({ edits }: { edits: HistoricalEdits }) {
    let { choosing, busy, error } = useSnapshot(edits)
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(choosing)
    if (choosing && choosing != last)
        setLast(choosing)
    let shown = choosing ?? last
    let files = shown?.count == 1 ? "1 file" : `${shown?.count} files`
    return (
        <Modal isOpen={choosing != undefined} onOpenChange={isOpen => isOpen || edits.cancelReturn()} isKeyboardDismissDisabled={busy}>
            <Dialog className="react-aria-Dialog return-dialog" aria-label={shown && `Return to ${shown.branch}`}>
                {shown && (
                    <>
                        <Heading slot="title">Return to {shown.branch}</Heading>
                        <p>
                            Historical Working Changes remain in {files}. Drop them, or bring them along onto the latest{" "}
                            {shown.branch}. Your earlier Working Changes are restored first.
                        </p>
                        <FormError message={error} />
                        <div className="dialog-actions">
                            <Button variant="secondary" isDisabled={busy} onPress={edits.cancelReturn}>Cancel</Button>
                            <Button variant="secondary" isDisabled={busy} onPress={() => void edits.choose("drop")}>Drop</Button>
                            <Button variant="accent" isDisabled={busy} onPress={() => void edits.choose("bring")} autoFocus>Bring along</Button>
                        </div>
                    </>
                )}
            </Dialog>
        </Modal>
    )
}
