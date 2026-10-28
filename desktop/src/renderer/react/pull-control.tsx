import { Button as AriaButton } from "react-aria-components"
import type { BackgroundFetch } from "./background-fetch"
import { Hint } from "./controls"
import { CloseIcon, FetchFailedIcon, FetchIcon, PullIcon } from "./icons"
import type { PullLatest } from "./pull-latest"
import { Button } from "./ui/Button"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"

/**
 * Pull latest on a column's own branch heading, for the column's Active Stack and the open stacks sharing a branch
 * above its Base. It takes the accent colour while the Branch Graph knows of commits to bring in, which its tooltip
 * lists. While its pull runs, it cancels the pull, with the pull's progress beside it.
 */
export function PullButton({ pull, repositoryId, branch, name, incoming, remotes, busy }: {
    pull: PullLatest
    repositoryId: string
    /** The column's local branch. */
    branch: string
    name: string
    /** What the Branch Graph knows the pull would bring in; see `incoming`. */
    incoming: string[]
    /** The repository has a remote to pull from. */
    remotes: boolean
    /** Another operation is running, which can move the stack. */
    busy: boolean
}) {
    let run = useSnapshot(pull).running[repositoryId]
    let progress = run?.branch == branch ? run : undefined
    let reason = !remotes ? "Add a remote to pull." : run && !progress ? "Another pull is running." : undefined
    let label = progress ? "Cancel pull" : `Pull latest for ${name}`
    let disabled = progress ? progress.cancelling : busy || reason != undefined
    // While its pull runs the button stays, as Cancel, so it keeps focus.
    let press = () => {
        if (progress)
            void pull.cancel(repositoryId)
        else
            void pull.start(repositoryId, branch)
    }
    return (
        // The hint explains a disabled button too, so it sits on a wrapper.
        <Hint text={progress ? undefined : reason} forControl>
            <span className="pull-slot">
                {progress && <span className="pull-progress" role="status">{progress.message}</span>}
                <TooltipTrigger isDisabled={disabled}>
                    <AriaButton
                        className="icon-button small pull-button"
                        data-incoming={!progress && incoming.length > 0 || undefined}
                        aria-label={label}
                        isDisabled={disabled}
                        onPress={press}
                    >
                        {progress ? <CloseIcon /> : <PullIcon />}
                    </AriaButton>
                    <Tooltip className="react-aria-Tooltip pull-tooltip">
                        <span className="pull-tooltip-label">{label}</span>
                        {!progress && (incoming.length
                            ? <ul className="pull-incoming">{incoming.map(line => <li key={line}>{line}</li>)}</ul>
                            : <span>Up to date as of the last fetch</span>)}
                    </Tooltip>
                </TooltipTrigger>
            </span>
        </Hint>
    )
}

/**
 * Fetch in the header. The active repository fetches in the background; this fetches it now. Its tooltip says when
 * it last fetched, and a failed fetch marks it, with the reason in its hint, until a fetch succeeds.
 */
export function FetchButton({ fetching, repositoryId, remotes }: {
    fetching: BackgroundFetch
    repositoryId: string
    /** The repository has a remote to fetch from; unknown until its Branch Graph loads. */
    remotes?: boolean
}) {
    let { running, fetched, failures } = useSnapshot(fetching)
    let failure = failures[repositoryId]
    let last = fetched[repositoryId]
    let hint = remotes == undefined
        ? "Loading the Branch Graph…"
        : !remotes
        ? "Add a remote to fetch."
        : failure
        ? `Fetching failed: ${failure}`
        : undefined
    return (
        <Hint text={hint} forControl>
            <span className="fetch-slot">
                <TooltipTrigger isDisabled={hint != undefined}>
                    <Button
                        variant="quiet"
                        aria-label="Fetch"
                        data-failed={failure != undefined && remotes || undefined}
                        isDisabled={!remotes}
                        isPending={running[repositoryId]}
                        pendingLabel="Fetching…"
                        onPress={() => void fetching.fetchNow()}
                    >
                        {failure != undefined && remotes ? <FetchFailedIcon /> : <FetchIcon />}
                    </Button>
                    <Tooltip>{last == undefined ? "Fetch" : `Fetch · last fetched at ${fetchTime.format(last)}`}</Tooltip>
                </TooltipTrigger>
            </span>
        </Hint>
    )
}

let fetchTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })
