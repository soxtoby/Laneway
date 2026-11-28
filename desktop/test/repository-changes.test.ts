import type { ChangedFile, ChangedWorktreesResult } from "@laneway/shared"
import { expect, test } from "bun:test"
import type { ColumnInspection, InspectionSnapshot } from "../src/renderer/react/inspection"
import { createRepositoryChanges, type RepositoryChangesEnvironment } from "../src/renderer/react/repository-changes"
import { createStore } from "../src/renderer/react/store"

test("createRepositoryChanges with an active repository counts it from its columns once they all read, and checks the others", async () => {
    let inspection = createStore<InspectionSnapshot>(inspected("alpha", {}))
    let checked: string[] = []
    let sut = createRepositoryChanges({
        api: fakeApi(async repositoryId => {
            checked.push(repositoryId)
            return changes(repositoryId == "alpha" ? 3 : 1)
        }),
        inspection,
        environment: fakeEnvironment().environment,
    })

    sut.retain(repositories("alpha", "beta"), "alpha")
    await Bun.sleep(0)

    expect(checked).toEqual(["alpha", "beta"])
    expect(sut.snapshot()).toEqual({ alpha: { count: 3, unseen: false }, beta: { count: 1, unseen: true } })

    inspection.publish(inspected("alpha", { main: worktreeColumn("D:\\alpha", [changed("a.txt")]), linked: worktreeColumn("D:\\alpha-linked") }))

    expect(sut.snapshot().alpha).toEqual({ count: 3, unseen: false })

    inspection.publish(
        inspected("alpha", { main: worktreeColumn("D:\\alpha", [changed("a.txt")]), linked: worktreeColumn("D:\\alpha-linked", [ignored("out.log")]) }),
    )
    await sut.check("alpha")

    expect(sut.snapshot().alpha).toEqual({ count: 1, unseen: false })
    expect(checked).toEqual(["alpha", "beta"])
})

test("createRepositoryChanges with a repository left behind shows its changes as seen until they change", async () => {
    let versions: Record<string, string> = { alpha: "first", beta: "first" }
    let sut = createRepositoryChanges({
        api: fakeApi(async repositoryId => changes(1, versions[repositoryId])),
        inspection: createStore<InspectionSnapshot>(inspected(undefined, {})),
        environment: fakeEnvironment().environment,
    })
    sut.retain(repositories("alpha", "beta"), "alpha")
    await Bun.sleep(0)

    sut.retain(repositories("alpha", "beta"), "beta")
    let leaving = sut.snapshot()
    await Bun.sleep(0)
    let left = sut.snapshot()
    versions.alpha = "edited"
    await sut.check("alpha")
    let edited = sut.snapshot()
    sut.retain(repositories("alpha", "beta"), "alpha")
    let returned = sut.snapshot()

    expect(leaving).toEqual({ alpha: { count: 1, unseen: false }, beta: { count: 1, unseen: false } })
    expect(left).toEqual(leaving)
    expect(edited.alpha).toEqual({ count: 1, unseen: true })
    expect(returned.alpha).toEqual({ count: 1, unseen: false })
})

test("createRepositoryChanges with versions seen before a restart shows those changes as seen until they change", async () => {
    let versions: Record<string, string> = { alpha: "first", beta: "edited" }
    let sut = createRepositoryChanges({
        api: fakeApi(async repositoryId => changes(1, versions[repositoryId])),
        inspection: createStore<InspectionSnapshot>(inspected(undefined, {})),
        environment: fakeEnvironment().environment,
    })

    sut.retain([{ id: "alpha", seenChangesVersion: "first" }, { id: "beta", seenChangesVersion: "first" }])
    await Bun.sleep(0)
    let restarted = sut.snapshot()
    versions.alpha = "edited"
    await sut.check("alpha")

    expect(restarted).toEqual({ alpha: { count: 1, unseen: false }, beta: { count: 1, unseen: true } })
    expect(sut.snapshot().alpha).toEqual({ count: 1, unseen: true })
})

test("createRepositoryChanges with a repository left behind saves the version it was left at, over an older one in the workspace", async () => {
    let saved: Record<string, string> = {}
    let sut = createRepositoryChanges({
        api: fakeApi(async () => changes(1, "edited"), saved),
        inspection: createStore<InspectionSnapshot>(inspected(undefined, {})),
        environment: fakeEnvironment().environment,
    })
    let workspace = [{ id: "alpha", seenChangesVersion: "first" }, { id: "beta" }]
    sut.retain(workspace, "alpha")
    await Bun.sleep(0)

    sut.retain(workspace, "beta")
    await Bun.sleep(0)
    sut.retain(workspace, "beta")

    expect(saved).toEqual({ alpha: "edited" })
    expect(sut.snapshot().alpha).toEqual({ count: 1, unseen: false })
})

test("createRepositoryChanges with a check answered after the columns read keeps the columns' count", async () => {
    let inspection = createStore<InspectionSnapshot>(inspected("alpha", {}))
    let answer: (result: ChangedWorktreesResult) => void = () => {}
    let sut = createRepositoryChanges({
        api: fakeApi(() => new Promise(resolve => answer = resolve)),
        inspection,
        environment: fakeEnvironment().environment,
    })

    sut.retain(repositories("alpha"), "alpha")
    inspection.publish(inspected("alpha", { main: worktreeColumn("D:\\alpha", []) }))
    answer(changes(1))
    await Bun.sleep(0)

    expect(sut.snapshot()).toEqual({ alpha: { count: 0, unseen: false } })
})

test("createRepositoryChanges checks every repository in turn on focus and while focused, never two at once", async () => {
    let { environment, advance, focus, setFocused } = fakeEnvironment()
    let answers: Array<{ repositoryId: string; resolve(result: ChangedWorktreesResult): void }> = []
    let sut = createRepositoryChanges({
        api: fakeApi(repositoryId => new Promise(resolve => answers.push({ repositoryId, resolve }))),
        inspection: createStore<InspectionSnapshot>(inspected(undefined, {})),
        environment,
    })
    sut.retain(repositories("alpha", "beta"))
    await answerAll(answers, 0)

    await focus()
    await focus()

    expect(answers.map(answer => answer.repositoryId)).toEqual(["alpha"])

    await answerAll(answers, 2)

    expect(sut.snapshot()).toEqual({ alpha: { count: 2, unseen: true }, beta: { count: 2, unseen: true } })

    setFocused(false)
    await advance(15_000)

    expect(answers).toHaveLength(0)

    setFocused(true)
    await advance(15_000)

    expect(answers.map(answer => answer.repositoryId)).toEqual(["alpha"])
})

test("createRepositoryChanges with a failed check keeps the last count, and drops repositories no longer retained", async () => {
    let results: ChangedWorktreesResult[] = [changes(1), changes(0), { ok: false, error: { code: "git.command-failed", message: "Locked." } }]
    let sut = createRepositoryChanges({
        api: fakeApi(async () => results.shift()!),
        inspection: createStore<InspectionSnapshot>(inspected(undefined, {})),
        environment: fakeEnvironment().environment,
    })
    sut.retain(repositories("alpha", "beta"))
    await Bun.sleep(0)

    await sut.check("alpha")
    sut.retain(repositories("alpha"))

    expect(sut.snapshot()).toEqual({ alpha: { count: 1, unseen: true } })
})

/** Answers each check with `read`, keeping each repository's version when it was left in `saved`. */
function fakeApi(read: (repositoryId: string) => Promise<ChangedWorktreesResult>, saved: Record<string, string> = {}) {
    return {
        readChangedWorktrees: read,
        async markChangesSeen(repositoryId: string, version: string) {
            saved[repositoryId] = version
        },
    }
}

function repositories(...ids: string[]) {
    return ids.map(id => ({ id }))
}

function changes(count: number, version = `${count} changed`): ChangedWorktreesResult {
    return { ok: true, changes: { count, version } }
}

async function answerAll(answers: Array<{ resolve(result: ChangedWorktreesResult): void }>, count: number) {
    while (answers.length) {
        answers.shift()!.resolve(changes(count))
        await Bun.sleep(0)
    }
}

function inspected(repositoryId: string | undefined, columns: Record<string, ColumnInspection>): InspectionSnapshot {
    return { repositoryId, columns, auxiliary: {}, wrapLines: false }
}

/** A worktree's column; without files it is still reading its Working Changes. */
function worktreeColumn(worktreePath: string, files?: ChangedFile[]): ColumnInspection {
    let source = { kind: "working" as const, worktreePath }
    let working = { source, inventory: files && { source, version: "1", parents: [], files }, loading: !files, open: true }
    return { worktreePath, files: { working }, selected: [], showIgnored: false, history: {}, bases: {}, diffs: {} }
}

function changed(path: string): ChangedFile {
    return { path, status: "modified", staged: false, unstaged: true, untracked: false, ignored: false, conflicted: false }
}

function ignored(path: string): ChangedFile {
    return { ...changed(path), status: "ignored", unstaged: false, ignored: true }
}

function fakeEnvironment() {
    let focused = true
    let now = 0
    let timers: Array<{ every: number; next: number; run(): void }> = []
    let focusListeners = new Set<() => void>()
    let environment: RepositoryChangesEnvironment = {
        focused: () => focused,
        every(intervalMs, run) {
            let timer = { every: intervalMs, next: now + intervalMs, run }
            timers.push(timer)
            return () => timers.splice(timers.indexOf(timer), 1)
        },
        onFocus(run) {
            focusListeners.add(run)
            return () => focusListeners.delete(run)
        },
    }
    return {
        environment,
        setFocused: (value: boolean) => focused = value,
        async advance(milliseconds: number) {
            now += milliseconds
            for (let timer of [...timers]) {
                while (timer.next <= now) {
                    timer.next += timer.every
                    timer.run()
                }
            }
            await Bun.sleep(0)
        },
        async focus() {
            for (let listener of focusListeners)
                listener()
            await Bun.sleep(0)
        },
    }
}
