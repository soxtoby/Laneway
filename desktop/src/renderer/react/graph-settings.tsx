import type { BranchGraph, RepositoryGraphSettings } from "@laneway/shared"
import { useState } from "react"
import { Button as AriaButton, Form, Radio, RadioGroup } from "react-aria-components"
import { SettingsIcon } from "./icons"
import { Button } from "./ui/Button"
import { Dialog, DialogTrigger, Heading } from "./ui/Dialog"
import { Description, Label } from "./ui/Form"
import { Popover } from "./ui/Popover"
import { TextField } from "./ui/TextField"

/**
 * The Branch Graph's settings: the remote its Primary Branch and remote branches come from, when there is a choice,
 * and remote-only branches to show besides. A remote applies as it is chosen; patterns apply on Enter or Apply.
 */
export function GraphSettings({ graph, onApply }: { graph: BranchGraph; onApply(settings: RepositoryGraphSettings): Promise<void> }) {
    let [open, setOpen] = useState(false)
    return (
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
            <AriaButton className="icon-button" aria-label="Branch Graph settings">
                <SettingsIcon />
            </AriaButton>
            <Popover placement="bottom end" className="graph-settings-popover">
                <Dialog className="react-aria-Dialog graph-settings">
                    {/* Mounted afresh on each opening, so a typed draft survives quiet refreshes while it shows. */}
                    <GraphSettingsForm
                        graph={graph}
                        onApply={settings => {
                            setOpen(false)
                            return onApply(settings)
                        }}
                    />
                </Dialog>
            </Popover>
        </DialogTrigger>
    )
}

function GraphSettingsForm({ graph, onApply }: { graph: BranchGraph; onApply(settings: RepositoryGraphSettings): Promise<void> }) {
    let [patterns, setPatterns] = useState(graph.remotePatterns.join(", "))
    let apply = (selectedRemote = graph.selectedRemote) => void onApply({ selectedRemote, remotePatterns: splitPatterns(patterns) })
    return (
        <Form
            onSubmit={event => {
                event.preventDefault()
                apply()
            }}
        >
            <Heading slot="title">Branch Graph settings</Heading>
            {/* With a single remote there is nothing to choose. */}
            {graph.availableRemotes.length > 1 && (
                <RadioGroup className="graph-remotes" value={graph.selectedRemote ?? null} onChange={remote => apply(remote)}>
                    <Label>Remote</Label>
                    <Description>The Primary Branch and remote branches come from this remote.</Description>
                    {graph.availableRemotes.map(remote => <Radio key={remote} value={remote} className="graph-remote">{remote}</Radio>)}
                </RadioGroup>
            )}
            <TextField
                label="Additional remote branches"
                description="Also show remote-only branches matching these comma-separated globs, such as origin/release/**."
                placeholder="origin/release/**, upstream/topic/*"
                value={patterns}
                onChange={setPatterns}
                autoFocus
            />
            <div className="graph-settings-actions">
                <Button variant="secondary" type="submit">Apply</Button>
            </div>
        </Form>
    )
}

function splitPatterns(value: string) {
    return value.split(",").map(pattern => pattern.trim()).filter(Boolean)
}
