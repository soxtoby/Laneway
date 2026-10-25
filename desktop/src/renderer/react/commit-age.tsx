import { createContext, useContext, useSyncExternalStore } from "react"
import { commitAge } from "./commit-dates"
import { Hint } from "./controls"

/** Whether commit rows show their ages, as the setting a column's menu toggles says. */
export let CommitAgesShown = createContext(true)

/** When a commit was authored: its age at a glance, with the full local date and time on hover. */
export function CommitAge({ authoredAt }: { authoredAt: number }) {
    let shown = useContext(CommitAgesShown)
    let now = useSyncExternalStore(shown ? watchClock : ignoreClock, () => clock)
    if (!shown)
        return null

    let date = new Date(authoredAt * 1000)
    return (
        <Hint text={`Authored ${new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(date)}`}>
            <time className="commit-age" dateTime={date.toISOString()}>{commitAge(authoredAt, now)}</time>
        </Hint>
    )
}

// The time ages count from. It moves on each minute while any age shows, so ages stay current without their rows
// rendering again.
let clock = new Date()
let ticking = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function watchClock(changed: () => void) {
    if (ticking.size == 0) {
        clock = new Date()
        timer = setInterval(() => {
            clock = new Date()
            for (let tick of ticking)
                tick()
        }, 60_000)
    }
    ticking.add(changed)
    return () => {
        ticking.delete(changed)
        if (ticking.size == 0)
            clearInterval(timer)
    }
}

function ignoreClock() {
    return () => {}
}
