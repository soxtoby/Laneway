/** @jsxImportSource react */
import { useState } from "react"
import { Radio, RadioGroup } from "react-aria-components"
import { type BranchRebase, plural } from "./branch-rebase"
import { FormError } from "./form-error"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Dialog, Heading } from "./ui/Dialog"
import { Label } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { useSnapshot } from "./use-snapshot"

/**
 * Reviewing a branch rebase that needs a decision: which tip to rebase onto, whether dependents move too, and
 * whether to rewrite published history or go on with conflicts. Cancel waits while the rebase runs.
 */
export function RebaseDialog({ rebase }: { rebase: BranchRebase }) {
    let { pending, busy, executing } = useSnapshot(rebase)
    let open = pending?.dialog ? pending : undefined
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(open)
    if (open && open != last)
        setLast(open)
    let current = open ?? last
    let reviewed = current?.preview?.composition
    let base = current?.source.base
    let baseName = base?.status == "known" ? base.name : base?.candidates.map(candidate => candidate.name).join(" / ")
    let commits = reviewed?.commits ?? []
    return (
        <Modal isOpen={open != undefined} onOpenChange={isOpen => isOpen || rebase.cancel()} isKeyboardDismissDisabled={executing}>
            <Dialog className="react-aria-Dialog rebase-dialog" aria-label={current && `Rebase ${current.source.name}`}>
                {current && (
                    <>
                        <Heading slot="title">Rebase {current.source.name}</Heading>
                        {current.destinations.length > 1
                            ? (
                                <RadioGroup
                                    className="rebase-destinations"
                                    value={current.destination.branch}
                                    isDisabled={busy}
                                    onChange={branch => rebase.setDestination(current.destinations.find(choice => choice.branch == branch)!)}
                                >
                                    <Label>Onto</Label>
                                    {current.destinations.map(choice => (
                                        <Radio key={choice.branch} value={choice.branch} className="rebase-destination">
                                            <strong>{choice.name}</strong>
                                            <small>{choice.detail}</small>
                                        </Radio>
                                    ))}
                                </RadioGroup>
                            )
                            : (
                                <p>
                                    Onto <strong>{current.destination.name}</strong>
                                </p>
                            )}
                        {commits.length > 0 && (
                            <section className="rebase-commits" aria-label="Commits to move">
                                <p>{plural(commits.length, "commit")} since {baseName}</p>
                                <ol>
                                    {commits.slice(0, 8).map(commit => (
                                        <li key={commit.objectId}>
                                            <code>{commit.objectId.slice(0, 8)}</code> {commit.subject}
                                        </li>
                                    ))}
                                </ol>
                                {commits.length > 8 && <p>and {plural(commits.length - 8, "more commit")}</p>}
                            </section>
                        )}
                        {current.dependents.length > 0 && (
                            <Checkbox isSelected={current.descendants} isDisabled={busy} onChange={rebase.setDescendants}>
                                Move dependent branches too: {current.dependents.join(", ")}
                            </Checkbox>
                        )}
                        {reviewed?.noop && <p>{current.source.name} is already on top of {current.destination.name}.</p>}
                        {!!reviewed?.published.length && (
                            <p className="rebase-warning" role="alert">
                                Rewrites history already published on {reviewed.published.join(", ")}. The next Publish needs force-with-lease.
                            </p>
                        )}
                        {!!reviewed?.removed.length && <p>Removes commits left empty: {reviewed.removed.map(commit => commit.slice(0, 8)).join(", ")}</p>}
                        {!!reviewed?.conflicts.length && (
                            <p>Conflicts in {reviewed.conflicts.map(conflict => `${conflict.subject}: ${conflict.files.join(", ")}`).join("; ")}</p>
                        )}
                        {busy && <p className="rebase-status" role="status">{current.preview ? "Rebasing…" : "Reviewing…"}</p>}
                        <FormError message={current.error || undefined} />
                        <div className="dialog-actions">
                            <Button variant="secondary" isDisabled={executing} onPress={rebase.cancel}>Cancel</Button>
                            {!current.preview && current.error && (
                                <Button variant="secondary" isDisabled={busy} onPress={() => void rebase.review()}>Review again</Button>
                            )}
                            {reviewed?.conflicts.length
                                ? (
                                    <>
                                        <Button variant="secondary" isDisabled={busy} onPress={() => void rebase.execute(false)}>
                                            Continue and resolve later
                                        </Button>
                                        {rebase.resolves && (
                                            <Button variant="accent" isDisabled={busy} onPress={() => void rebase.execute(true)} autoFocus>
                                                Continue and resolve now
                                            </Button>
                                        )}
                                    </>
                                )
                                : (
                                    <Button
                                        variant="accent"
                                        isDisabled={busy || !reviewed || reviewed.noop}
                                        onPress={() => void rebase.execute(false)}
                                        autoFocus
                                    >
                                        Rebase
                                    </Button>
                                )}
                        </div>
                    </>
                )}
            </Dialog>
        </Modal>
    )
}
