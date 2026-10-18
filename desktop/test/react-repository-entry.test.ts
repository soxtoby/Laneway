import type { GitSettingsState } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { createGitSettings } from "../src/renderer/react/git-settings"
import { createRepositoryEntry } from "../src/renderer/react/repository-entry"
import { appState, fakeLaneway } from "./renderer-fixtures"

describe("repository entry", () => {
    test("a name suggested for an earlier clone source is dropped", async () => {
        let suggestions = new Map<string, PromiseWithResolver<string>>()
        let entry = createRepositoryEntry({
            api: fakeLaneway({ suggestCloneDirectoryName: source => withResolver(suggestions, source) }),
            notify: () => undefined,
            workspaceOpened: () => undefined,
            openRepository: async () => undefined,
        })
        await entry.openClone()

        entry.setClone({ source: "https://host/team/old.git" })
        entry.setClone({ source: "https://host/team/new.git" })
        suggestions.get("https://host/team/new.git")!.resolve("new")
        suggestions.get("https://host/team/old.git")!.resolve("old")
        await settle()

        expect(entry.snapshot().clone.name).toBe("new")
    })

    test("a typed directory name stays when the source changes", async () => {
        let entry = createRepositoryEntry({
            api: fakeLaneway({ suggestCloneDirectoryName: async () => "suggested" }),
            notify: () => undefined,
            workspaceOpened: () => undefined,
            openRepository: async () => undefined,
        })
        await entry.openClone()

        entry.setClone({ name: "chosen" })
        entry.setClone({ source: "https://host/team/project.git" })
        await settle()

        expect(entry.snapshot().clone.name).toBe("chosen")
    })

    test("the initialize dialog stays open while Git runs", async () => {
        let finish: () => void = () => undefined
        let entry = createRepositoryEntry({
            api: fakeLaneway({
                initializeRepository: () =>
                    new Promise(resolve => finish = () => resolve({ ok: false, error: { code: "git.command-failed", message: "Failed" } })),
            }),
            notify: () => undefined,
            workspaceOpened: () => undefined,
            openRepository: async () => undefined,
        })
        await entry.openInitialize()

        let initializing = entry.submitInitialize()
        await entry.dismiss()
        expect(entry.snapshot()).toMatchObject({ dialog: "initialize", operation: "initializing" })

        finish()
        await initializing
        expect(entry.snapshot()).toMatchObject({ dialog: "initialize", operation: "idle", initialize: { error: { message: "Failed" } } })
    })
})

describe("Git settings", () => {
    test("saving identities sends the trimmed emails and shows the saved settings", async () => {
        let sent: unknown[] = []
        let gitSettings = createGitSettings({
            api: fakeLaneway({
                setAuthorIdentities: async identities => {
                    sent.push(identities)
                    return { ...appState().settings, authorIdentities: identities } satisfies GitSettingsState
                },
            }),
            notify: () => undefined,
        })
        gitSettings.load(appState().settings)
        gitSettings.open()

        gitSettings.setPrimaryEmail("  me@example.test ")
        gitSettings.setSecondaryEmails("work@example.test, , old@example.test ")
        await gitSettings.saveIdentities()

        let identities = { primary: "me@example.test", secondary: ["work@example.test", "old@example.test"] }
        expect(sent).toEqual([identities])
        expect(gitSettings.snapshot()).toMatchObject({ action: "idle", settings: { authorIdentities: identities } })
    })
})

type PromiseWithResolver<T> = { promise: Promise<T>; resolve(value: T): void }

function withResolver<T>(pending: Map<string, PromiseWithResolver<T>>, key: string) {
    let resolve: (value: T) => void = () => undefined
    let promise = new Promise<T>(done => resolve = done)
    pending.set(key, { promise, resolve })
    return promise
}

// Lets background reads run to their next await.
async function settle() {
    for (let turn = 0; turn < 10; turn++)
        await Promise.resolve()
}
