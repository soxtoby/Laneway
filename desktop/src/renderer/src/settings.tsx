import type { GitSettingsState } from "@git-workbench/shared"
import { on, ref, type Handle, type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "./feedback"

type SettingsAction = "idle" | "choosing" | "path" | "resetting" | "opening-file"

interface SettingsOptions {
    api: Window["workbench"]
    initial: GitSettingsState
    update(): Promise<AbortSignal>
    notify(notice: NoticeState): void
}

export interface GitSettings {
    readonly current: GitSettingsState
    open(): void
    render(): RemixNode
}

export function createGitSettings(options: SettingsOptions): GitSettings {
    let settings = options.initial
    let action: SettingsAction = "idle"
    let dialog: HTMLDialogElement

    function showFailure(code: string, error: unknown) {
        options.notify({ code, message: errorMessage(error) })
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
            const error = await options.api.openSettingsFile()
            if (error)
                options.notify({ code: "settings.open-failed", message: error })
        } catch (error) {
            showFailure("settings.open.failed", error)
        } finally {
            action = "idle"
            await options.update()
        }
    }

    return {
        get current() {
            return settings
        },
        open() {
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
                />
            )
        },
    }
}

function SettingsDialog(handle: Handle<{
    settings: GitSettingsState
    action: SettingsAction
    dialogRef(node: HTMLDialogElement): void
    close(): void
    choose(): void
    usePath(): void
    reset(): void
    openFile(): void
}>) {
    return () => {
        const pending = handle.props.action != "idle"
        return (
            <dialog aria-labelledby="settings-heading" mix={[ref(handle.props.dialogRef)]}>
                <section class="settings-panel">
                    <header><span class="sequence">CFG</span><div><p class="eyebrow">Application setting</p><h2 id="settings-heading">System Git</h2></div></header>
                    {handle.props.settings.error
                        ? (
                            <div class="settings-error">
                                <strong>{handle.props.settings.error.code}</strong><p>{handle.props.settings.error.message}</p>
                                <div><button type="button" disabled={pending} mix={[on("click", handle.props.openFile)]}>Open settings file</button><button type="button" disabled={pending} mix={[on("click", handle.props.reset)]}>Reset settings</button></div>
                            </div>
                        )
                        : (
                            <dl class="settings-facts">
                                <Fact label="Executable" value={handle.props.settings.git?.path ?? "Unavailable"} />
                                <Fact label="Version" value={handle.props.settings.git?.version ?? "Unavailable"} />
                                <Fact label="Selection" value={handle.props.settings.override ? "Application override" : "PATH"} />
                                <Fact label="Settings file" value={handle.props.settings.path} />
                            </dl>
                        )}
                    <footer class="dialog-actions">
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
    return () => <div><dt>{handle.props.label}</dt><dd title={handle.props.value}>{handle.props.value}</dd></div>
}
