import { useId } from "react"
import { Hint } from "./controls"
import type { GitSettings } from "./git-settings"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

/** The System Git dialog. While a change runs, its controls wait. */
export function GitSettingsDialog({ gitSettings }: { gitSettings: GitSettings }) {
    let { isOpen, settings, action, primaryEmail, secondaryEmails } = useSnapshot(gitSettings)
    let identityHeadingId = useId()
    let pending = action != "idle"
    return (
        <Modal isOpen={isOpen} onOpenChange={open => open || gitSettings.close()}>
            <Dialog className="react-aria-Dialog settings-dialog">
                <Heading slot="title">System Git</Heading>
                {settings.error
                    ? (
                        <div className="settings-error">
                            <strong>{settings.error.code}</strong>
                            <p>{settings.error.message}</p>
                            <div className="settings-error-actions">
                                <Button variant="secondary" isDisabled={pending} onPress={() => void gitSettings.openSettingsFile()}>Open settings file</Button>
                                <Button variant="secondary" isDisabled={pending} onPress={() => void gitSettings.reset()}>Reset settings</Button>
                            </div>
                        </div>
                    )
                    : (
                        <dl className="settings-facts">
                            <Fact label="Executable" value={settings.git?.path ?? "Unavailable"} />
                            <Fact label="Version" value={settings.git?.version ?? "Unavailable"} />
                            <Fact label="Selection" value={settings.override ? "Application override" : "PATH"} />
                            <Fact label="Settings file" value={settings.path} />
                        </dl>
                    )}
                <section className="identity-settings" aria-labelledby={identityHeadingId}>
                    <h3 id={identityHeadingId} className="identity-heading">Author identities</h3>
                    <TextField
                        label="Primary email"
                        type="email"
                        value={primaryEmail}
                        onChange={gitSettings.setPrimaryEmail}
                        placeholder="Detected from Git when empty"
                        isDisabled={pending}
                    />
                    <TextField
                        label="Secondary emails"
                        description="Used with mailmap to decide which branches are involved."
                        value={secondaryEmails}
                        onChange={gitSettings.setSecondaryEmails}
                        placeholder="Comma-separated"
                        isDisabled={pending}
                    />
                    <Button variant="secondary" isDisabled={pending} onPress={() => void gitSettings.saveIdentities()}>Save identities</Button>
                </section>
                <div className="dialog-actions">
                    <Button variant="quiet" isDisabled={pending} onPress={gitSettings.close}>Close</Button>
                    <Button variant="secondary" isDisabled={pending} onPress={() => void gitSettings.useGitFromPath()}>Use Git from PATH</Button>
                    <Button variant="accent" isDisabled={pending} onPress={() => void gitSettings.chooseExecutable()}>Choose executable</Button>
                </div>
            </Dialog>
        </Modal>
    )
}

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div className="settings-fact">
            <dt>{label}</dt>
            <Hint text={value}>
                <dd>{value}</dd>
            </Hint>
        </div>
    )
}
