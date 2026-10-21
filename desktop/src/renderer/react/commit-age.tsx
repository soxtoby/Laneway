import { commitAge } from "./commit-dates"
import { Hint } from "./controls"

/** When a commit was authored: its age at a glance, with the full local date and time on hover. */
export function CommitAge({ authoredAt }: { authoredAt: number }) {
    let date = new Date(authoredAt * 1000)
    // The age is as fresh as the row's last render, which is close enough for a glance.
    return (
        <Hint text={`Authored ${new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(date)}`}>
            <time className="commit-age" dateTime={date.toISOString()}>{commitAge(authoredAt)}</time>
        </Hint>
    )
}
