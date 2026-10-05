import { type FSWatcher, watch } from "node:fs"

// Paths under the Git common directory whose changes move branches, HEADs, or worktree registrations.
// Object writes, index updates, and reflogs are left to the renderer's slower polling.
let relevant = /^(HEAD|ORIG_HEAD|packed-refs|refs[\\/].+|worktrees([\\/][^\\/]+([\\/]HEAD)?)?)$/

/**
 * Watches one repository's Git common directory and reports relevant changes after a short quiet
 * period. Returns a function that stops watching. Platforms without recursive watching fall back to
 * reporting nothing, which leaves polling in charge.
 */
export function watchRepository(commonDirectory: string, onChange: () => void, quietMs = 250): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let watcher: FSWatcher | undefined

    try {
        watcher = watch(commonDirectory, { recursive: true, persistent: false }, (_event, filename) => {
            let name = filename == null ? "" : filename.toString()
            if (name && !relevant.test(name))
                return

            clearTimeout(timer)
            timer = setTimeout(onChange, quietMs)
        })
        watcher.on("error", () => {
            watcher?.close()
            watcher = undefined
        })
    } catch {
        watcher = undefined
    }

    return () => {
        clearTimeout(timer)
        watcher?.close()
        watcher = undefined
    }
}
