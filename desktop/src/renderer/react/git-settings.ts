import type { GitSettingsState } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export type SettingsAction = "idle" | "choosing" | "path" | "resetting" | "opening-file" | "saving-identities"

export interface GitSettingsSnapshot {
    isOpen: boolean
    settings: GitSettingsState
    /** The settings change in flight; the dialog's controls wait for it. */
    action: SettingsAction
    primaryEmail: string
    secondaryEmails: string
}

export interface GitSettings extends Store<GitSettingsSnapshot> {
    /** Shows the settings read at startup. */
    load(settings: GitSettingsState): void
    open(): void
    close(): void
    chooseExecutable(): Promise<void>
    useGitFromPath(): Promise<void>
    reset(): Promise<void>
    openSettingsFile(): Promise<void>
    setPrimaryEmail(value: string): void
    setSecondaryEmails(value: string): void
    saveIdentities(): Promise<void>
}

/** The System Git dialog: which Git executable Laneway runs, and the author identities it treats as the user's. */
export function createGitSettings({ api, notify }: { api: Api; notify(notice: Notice): void }): GitSettings {
    let store = createStore<GitSettingsSnapshot>({
        isOpen: false,
        settings: { path: "", authorIdentities: { secondary: [] } },
        action: "idle",
        primaryEmail: "",
        secondaryEmails: "",
    })
    let state = store.snapshot
    let update = (change: Partial<GitSettingsSnapshot>) => store.publish({ ...state(), ...change })

    // One change at a time; a second request while one runs is ignored, as its controls are disabled.
    async function run(action: SettingsAction, change: () => Promise<GitSettingsState | void>) {
        if (state().action != "idle")
            return
        update({ action })
        try {
            let settings = await change()
            if (settings)
                update({ settings })
        } catch (error) {
            notify({ code: action == "opening-file" ? "settings.open.failed" : "settings.update.failed", message: errorMessage(error) })
        } finally {
            update({ action: "idle" })
        }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        load(settings) {
            update({ settings })
        },

        // The identity fields start from the saved identities each time the dialog opens.
        open() {
            let { authorIdentities } = state().settings
            update({ isOpen: true, primaryEmail: authorIdentities.primary ?? "", secondaryEmails: authorIdentities.secondary.join(", ") })
        },

        close() {
            if (state().action == "idle")
                update({ isOpen: false })
        },

        chooseExecutable: () => run("choosing", api.chooseGit),
        useGitFromPath: () => run("path", api.useGitFromPath),
        reset: () => run("resetting", api.resetSettings),

        openSettingsFile: () =>
            run("opening-file", async () => {
                let error = await api.openSettingsFile()
                if (error)
                    notify({ code: "settings.open-failed", message: error })
            }),

        setPrimaryEmail(primaryEmail) {
            update({ primaryEmail })
        },

        setSecondaryEmails(secondaryEmails) {
            update({ secondaryEmails })
        },

        saveIdentities: () =>
            run("saving-identities", () =>
                api.setAuthorIdentities({
                    primary: state().primaryEmail.trim() || undefined,
                    secondary: state().secondaryEmails.split(",").map(email => email.trim()).filter(Boolean),
                })),
    }
}
