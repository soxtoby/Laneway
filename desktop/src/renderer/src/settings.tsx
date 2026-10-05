import type { GitSettingsState } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "./feedback"

type SettingsAction = "idle" | "choosing" | "path" | "resetting" | "opening-file" | "saving-identities"

interface SettingsOptions {
    api: Window["laneway"]
    initial: GitSettingsState
    update(): Promise<AbortSignal>
    notify(notice: NoticeState): void
}

export interface GitSettings {
    readonly current: GitSettingsState
    open(): void
    render(): RemixNode
}

let settingsPanel = css({
    padding: "0 14px",
})

let settingsPanelHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
    marginLeft: "-14px",
    marginRight: "-14px",
})

let settingsHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

let settingsError = css({
    marginTop: "14px",
    padding: "10px 12px",
    color: "var(--danger)",
    border: "1px solid var(--danger-edge)",
    borderRadius: "4px",
    background: "var(--danger-wash)",
    fontSize: "12px",
    lineHeight: "1.5",
})

let settingsErrorP = css({
    margin: "6px 0 10px",
})

let settingsErrorDiv = css({
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
})

let settingsErrorButton = css({
    minHeight: "28px",
    padding: "0 14px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "500",
    letterSpacing: "0",
    textTransform: "none",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    background: "var(--control)",
    "&:hover:not(:disabled)": {
        background: "var(--control-hover)",
    },
})

let settingsFacts = css({
    margin: "14px 0 0",
})

let identitySettings = css({
    marginTop: "16px",
    paddingTop: "16px",
    paddingBottom: "4px",
    borderTop: "1px solid var(--line)",
})

let identityHeading = css({
    margin: "0 0 12px",
    fontSize: "13px",
    fontWeight: "600",
})

let identitySettingsLabel = css({
    display: "block",
    margin: "12px 0 5px",
})

let secondaryButton = css({
    minHeight: "28px",
    marginTop: "12px",
    padding: "0 14px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "500",
    textTransform: "none",
})

let dialogActions = css({
    marginLeft: "-14px",
    marginRight: "-14px",
})

let factDiv = css({
    padding: "9px 0",
    display: "grid",
    gridTemplateColumns: "110px minmax(0, 1fr)",
    gap: "12px",
    borderBottom: "1px solid var(--line)",
    "&:last-child": {
        borderBottom: 0,
    },
})

let factDd = css({
    overflowWrap: "anywhere",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.45",
})

export function createGitSettings(options: SettingsOptions): GitSettings {
    let settings = options.initial
    let action: SettingsAction = "idle"
    let dialog: HTMLDialogElement
    let primaryEmail = settings.authorIdentities.primary ?? ""
    let secondaryEmails = settings.authorIdentities.secondary.join(", ")

    return {
        get current() {
            return settings
        },
        open() {
            primaryEmail = settings.authorIdentities.primary ?? ""
            secondaryEmails = settings.authorIdentities.secondary.join(", ")
            dialog.showModal()
        },
        render() {
            return (
                <SettingsDialog
                    settings={settings}
                    action={action}
                    dialogRef={node => dialog = node}
                    close={() => dialog.close()}
                    choose={() => run("choosing", options.api.chooseGit)}
                    usePath={() => run("path", options.api.useGitFromPath)}
                    reset={() => run("resetting", options.api.resetSettings)}
                    openFile={openFile}
                    primaryEmail={primaryEmail}
                    secondaryEmails={secondaryEmails}
                    setPrimaryEmail={value => {
                        primaryEmail = value
                        void options.update()
                    }}
                    setSecondaryEmails={value => {
                        secondaryEmails = value
                        void options.update()
                    }}
                    saveIdentities={() => run("saving-identities", () =>
                        options.api.setAuthorIdentities({
                            primary: primaryEmail.trim() || undefined,
                            secondary: secondaryEmails.split(",").map(email => email.trim()).filter(Boolean),
                        }))}
                />
            )
        },
    }

    async function run(nextAction: SettingsAction, call: () => Promise<GitSettingsState>) {
        if (action != "idle")
            return

        action = nextAction
        await options.update()

        try {
            settings = await call()
        } catch (error) {
            showFailure("settings.update.failed", error)
        } finally {
            action = "idle"
            await options.update()
        }
    }

    async function openFile() {
        if (action != "idle")
            return

        action = "opening-file"
        await options.update()

        try {
            let error = await options.api.openSettingsFile()
            if (error)
                options.notify({ code: "settings.open-failed", message: error })
        } catch (error) {
            showFailure("settings.open.failed", error)
        } finally {
            action = "idle"
            await options.update()
        }
    }

    function showFailure(code: string, error: unknown) {
        options.notify({ code, message: errorMessage(error) })
    }
}

function SettingsDialog(
    handle: Handle<{
        settings: GitSettingsState
        action: SettingsAction
        dialogRef(node: HTMLDialogElement): void
        close(): void
        choose(): void
        usePath(): void
        reset(): void
        openFile(): void
        primaryEmail: string
        secondaryEmails: string
        setPrimaryEmail(value: string): void
        setSecondaryEmails(value: string): void
        saveIdentities(): void
    }>,
) {
    return () => {
        let pending = handle.props.action != "idle"
        return (
            <dialog aria-labelledby="settings-heading" mix={[ref(handle.props.dialogRef)]}>
                <section class="settings-panel" mix={settingsPanel}>
                    <header mix={settingsPanelHeader}>
                        <h2 id="settings-heading" mix={settingsHeading}>
                            System Git
                        </h2>
                    </header>
                    {handle.props.settings.error
                        ? (
                            <div class="settings-error" mix={settingsError}>
                                <strong>{handle.props.settings.error.code}</strong>
                                <p mix={settingsErrorP}>
                                    {handle.props.settings.error.message}
                                </p>
                                <div mix={settingsErrorDiv}>
                                    <button type="button" disabled={pending} mix={[settingsErrorButton, on("click", handle.props.openFile)]}>
                                        Open settings file
                                    </button>
                                    <button type="button" disabled={pending} mix={[settingsErrorButton, on("click", handle.props.reset)]}>
                                        Reset settings
                                    </button>
                                </div>
                            </div>
                        )
                        : (
                            <dl class="settings-facts" mix={settingsFacts}>
                                <Fact label="Executable" value={handle.props.settings.git?.path ?? "Unavailable"} />
                                <Fact label="Version" value={handle.props.settings.git?.version ?? "Unavailable"} />
                                <Fact label="Selection" value={handle.props.settings.override ? "Application override" : "PATH"} />
                                <Fact label="Settings file" value={handle.props.settings.path} />
                            </dl>
                        )}
                    <section class="identity-settings" aria-labelledby="identity-heading" mix={identitySettings}>
                        <h3 id="identity-heading" mix={identityHeading}>
                            Author identities
                        </h3>
                        <label for="primary-email" mix={identitySettingsLabel}>
                            Primary email
                        </label>
                        <input
                            id="primary-email"
                            type="email"
                            value={handle.props.primaryEmail}
                            placeholder="Detected from Git when empty"
                            disabled={pending}
                            mix={[on("input", event => handle.props.setPrimaryEmail(event.currentTarget.value))]}
                        />
                        <label for="secondary-emails" mix={identitySettingsLabel}>
                            Secondary emails
                        </label>
                        <input
                            id="secondary-emails"
                            value={handle.props.secondaryEmails}
                            placeholder="Comma-separated"
                            disabled={pending}
                            mix={[on("input", event => handle.props.setSecondaryEmails(event.currentTarget.value))]}
                        />
                        <p class="field-note">Used with mailmap to decide which branches are involved.</p>
                        <button class="secondary-button" type="button" disabled={pending} mix={[secondaryButton, on("click", handle.props.saveIdentities)]}>
                            Save identities
                        </button>
                    </section>
                    <footer class="dialog-actions" mix={dialogActions}>
                        <button class="text-button" type="button" disabled={pending} mix={[on("click", handle.props.close)]}>Close</button>
                        <button class="secondary-button" type="button" disabled={pending} mix={[on("click", handle.props.usePath)]}>Use Git from PATH</button>
                        <button class="primary-button" type="button" disabled={pending} mix={[on("click", handle.props.choose)]}>Choose executable</button>
                    </footer>
                </section>
            </dialog>
        )
    }
}

function Fact(handle: Handle<{ label: string; value: string }>) {
    return () => (
        <div mix={factDiv}>
            <dt>{handle.props.label}</dt>
            <dd title={handle.props.value} mix={factDd}>
                {handle.props.value}
            </dd>
        </div>
    )
}
