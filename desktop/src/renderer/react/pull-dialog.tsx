import type { PullStackOutcome, PullStackStatus } from "@laneway/shared"
import { useState } from "react"
import type { PullLatest } from "./pull-latest"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Disclosure, DisclosureHeader, DisclosurePanel } from "./ui/Disclosure"
import { Modal } from "./ui/Modal"
import { useSnapshot } from "./use-snapshot"

let statusLabels: Record<PullStackStatus, string> = {
    updated: "Updated",
    current: "Already current",
    "needs-resolution": "Needs resolution",
    skipped: "Skipped",
    failed: "Failed",
    cancelled: "Not started",
}

/**
 * A Pull latest that needs attention: what each remote's fetch did and how each stack came out, with stacks that
 * didn't simply update open. A stack left to resolve opens its branch's column.
 */
export function PullDialog({ pull, onResolve }: { pull: PullLatest; onResolve(repositoryId: string, branch: string): void }) {
    let { outcome: open } = useSnapshot(pull)
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(open)
    if (open && open != last)
        setLast(open)
    let outcome = open ?? last
    let result = outcome?.result
    let counts = new Map<PullStackStatus, number>()
    for (let stack of result?.stacks ?? [])
        counts.set(stack.status, (counts.get(stack.status) ?? 0) + 1)
    return (
        <Modal className="react-aria-Modal pull-modal" isOpen={open != undefined} isDismissable onOpenChange={isOpen => isOpen || pull.close()}>
            <Dialog className="react-aria-Dialog pull-outcome" aria-label="Pull latest outcome">
                <Heading slot="title">Pull latest</Heading>
                <div className="pull-outcome-body">
                    {outcome?.error && <p className="pull-error" role="alert">{outcome.error}</p>}
                    {result && (
                        <>
                            <p className="pull-summary">{result.message}</p>
                            {result.fetches.length > 0 && (
                                <ul className="pull-fetches">
                                    {result.fetches.map(fetch => (
                                        <li key={fetch.remote}>
                                            <span className="pull-status" data-status={fetch.status == "fetched" ? "updated" : "failed"}>
                                                {fetch.status == "fetched" ? "Fetched" : "Fetch failed"}
                                            </span>
                                            {fetch.remote}
                                            {fetch.message && <small>{fetch.message}</small>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {counts.size > 0 && (
                                <p className="pull-counts">
                                    {[...counts].map(([status, count]) => `${count} ${statusLabels[status].toLocaleLowerCase()}`).join(" · ")}
                                </p>
                            )}
                            <div className="pull-stacks">
                                {result.stacks.map(stack => (
                                    <StackOutcome
                                        key={stack.id}
                                        stack={stack}
                                        onResolve={branch => {
                                            pull.close()
                                            onResolve(outcome!.repositoryId, branch)
                                        }}
                                    />
                                ))}
                            </div>
                            {result.operation && (
                                <p className="pull-note">Undo reverses this pull's local changes across stacks. Fetched history stays available.</p>
                            )}
                        </>
                    )}
                </div>
                <div className="dialog-actions">
                    <Button variant="accent" onPress={pull.close} autoFocus>Close</Button>
                </div>
            </Dialog>
        </Modal>
    )
}

function StackOutcome({ stack, onResolve }: { stack: PullStackOutcome; onResolve(branch: string): void }) {
    let tip = stack.branches.at(-1) ?? ""
    return (
        <Disclosure className="react-aria-Disclosure pull-stack" defaultExpanded={stack.status != "current" && stack.status != "updated"}>
            <DisclosureHeader>
                <span className="pull-stack-heading">
                    <strong>{tip}</strong>
                    {stack.branches.length > 1 && <small>on {stack.branches.slice(0, -1).join(" › ")}</small>}
                </span>
                <span className="pull-status" data-status={stack.status}>{statusLabels[stack.status]}</span>
            </DisclosureHeader>
            <DisclosurePanel>
                <p>Stack: {stack.branches.join(" › ")}</p>
                {stack.message && <p>{stack.message}</p>}
                {stack.status == "needs-resolution" && <Button variant="secondary" onPress={() => onResolve(tip)}>Resolve in {tip}</Button>}
                {(stack.status == "updated" || stack.status == "needs-resolution") && (
                    <p className="pull-note">Rewritten branches keep their publication pending until you Publish.</p>
                )}
            </DisclosurePanel>
        </Disclosure>
    )
}
