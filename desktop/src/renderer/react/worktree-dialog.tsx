import type { WorktreePreview } from "@laneway/shared"
import { useState } from "react"
import { FormError } from "./form-error"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"
import type { WorktreeActions, WorktreeActionsSnapshot } from "./worktree-actions"

/** A reviewed worktree operation to confirm, or a failed one; Escape and Cancel wait while Git runs. */
export function WorktreeDialog({ worktrees }: { worktrees: WorktreeActions }) {
    let snapshot = useSnapshot(worktrees)
    let open = snapshot.preview != undefined || snapshot.error != undefined
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(snapshot)
    if (open && snapshot != last)
        setLast(snapshot)
    let { preview, error, busy, preserve, restore } = open ? snapshot : last
    let request = preview?.request
    let title = request ? `${request.action[0]!.toUpperCase()}${request.action.slice(1)} worktree` : "Worktree operation"
    return (
        <Modal isOpen={open} onOpenChange={isOpen => isOpen || worktrees.close()}>
            <Dialog className="react-aria-Dialog worktree-dialog">
                <Form
                    className="react-aria-Form entry-form"
                    onSubmit={event => {
                        event.preventDefault()
                        void worktrees.execute()
                    }}
                >
                    <Heading slot="title">{title}</Heading>
                    {preview && <PreviewDetails preview={preview} preserve={preserve} busy={busy} worktrees={worktrees} />}
                    <FormError message={error} />
                    {restore && <RestoreField restore={restore} busy={busy} worktrees={worktrees} />}
                    <div className="dialog-actions">
                        <Button variant="secondary" isDisabled={busy} onPress={worktrees.close}>Cancel</Button>
                        {preview && (
                            <Button type="submit" variant="accent" isDisabled={busy}>
                                {busy ? "Working…" : request?.action == "remove" ? "Remove worktree" : "Confirm"}
                            </Button>
                        )}
                    </div>
                </Form>
            </Dialog>
        </Modal>
    )
}

// A removal reaches the dialog only when the worktree has Working Changes; any other goes at once.
function PreviewDetails({ preview, preserve, busy, worktrees }: { preview: WorktreePreview; preserve: boolean; busy: boolean; worktrees: WorktreeActions }) {
    let request = preview.request
    return (
        <>
            {preview.destination && (
                <p>
                    Destination: <strong>{preview.destination}</strong>
                </p>
            )}
            <ul className="affected-paths" aria-label="Affected worktrees">
                {preview.affected.map(path => (
                    <li key={path}>
                        <strong>{path.split(/[\\/]/).pop()}</strong>
                        <span>{path}</span>
                    </li>
                ))}
            </ul>
            {(request.action == "switch" || request.action == "create") && (
                <p>
                    Working Changes are stashed before switching. A previous holder stays detached. Existing stashes remain available for explicit application.
                </p>
            )}
            {request.action == "remove" && (
                <>
                    <div className="worktree-keep">
                        <strong>Working Changes detected</strong>
                        <p>Keep these changes available after removing the worktree.</p>
                        <Checkbox isSelected={preserve} onChange={worktrees.setPreserve} isDisabled={busy}>
                            {preview.uniqueCommits ? "Create a protective branch and stash Working Changes" : "Stash Working Changes"}
                        </Checkbox>
                    </div>
                    {!preserve && <p>Delete Working Changes and Worktree-only Commits from visible state. Git state remains retained for undo.</p>}
                    {preview.ignoredCount > 0 && (
                        <p>
                            Deletes ignored files, which are outside undo: {preview.ignored.slice(0, 3).join(", ")}
                            {preview.ignoredCount > 3 ? ` and ${preview.ignoredCount - 3} more` : ""}.
                        </p>
                    )}
                </>
            )}
        </>
    )
}

/** Undoing a removal whose directory has since been taken restores the worktree under a new name beside it. */
function RestoreField({ restore, busy, worktrees }: { restore: NonNullable<WorktreeActionsSnapshot["restore"]>; busy: boolean; worktrees: WorktreeActions }) {
    return (
        <div className="field-with-action">
            <TextField
                label="Restore within the same parent"
                aria-label="Restored worktree basename"
                value={restore.name}
                onChange={worktrees.setRestoreName}
                isDisabled={busy}
                autoComplete="off"
                spellCheck="false"
            />
            <Button
                variant="secondary"
                isDisabled={busy || !restore.name.trim()}
                onPress={() => void worktrees.transition(restore.repositoryId, "undo", restore.name.trim())}
            >
                Restore worktree
            </Button>
        </div>
    )
}
