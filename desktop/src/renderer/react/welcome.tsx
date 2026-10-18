import type { GitSettingsState } from "@laneway/shared"
import { useId } from "react"
import { Button as AriaButton } from "react-aria-components"

export interface EntryChoices {
    busy: boolean
    onOpen(): void
    onClone(): void
    onInitialize(): void
}

/** Shown when no repository is open: the ways to add one, and why Git can't run if it can't. */
export function Welcome({ settings, ...choices }: EntryChoices & { settings: GitSettingsState }) {
    let headingId = useId()
    return (
        <main className="welcome">
            <section className="entry-panel" aria-labelledby={headingId}>
                <h2 id={headingId} className="entry-heading">No repository open</h2>
                {settings.error && <p className="entry-warning">Git unavailable. {settings.error.message}</p>}
                <EntryOptions {...choices} />
            </section>
        </main>
    )
}

/** The three ways to add a repository, on the Welcome screen and in the Add dialog. */
export function EntryOptions({ busy, onOpen, onClone, onInitialize }: EntryChoices) {
    return (
        <div className="entry-options">
            <EntryCard title="Open" description="Choose an existing repository root." isDisabled={busy} onPress={onOpen} />
            <EntryCard title="Clone" description="Copy a remote or local repository." isDisabled={busy} onPress={onClone} />
            <EntryCard title="Initialize" description="Create a repository in a directory." isDisabled={busy} onPress={onInitialize} />
        </div>
    )
}

function EntryCard({ title, description, isDisabled, onPress }: { title: string; description: string; isDisabled: boolean; onPress(): void }) {
    let descriptionId = useId()
    return (
        <AriaButton className="entry-card" aria-label={title} aria-describedby={descriptionId} isDisabled={isDisabled} onPress={onPress}>
            <strong className="entry-card-title">{title}</strong>
            <span id={descriptionId} className="entry-card-description">{description}</span>
        </AriaButton>
    )
}
