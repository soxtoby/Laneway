import type { EntryProgress, WorkbenchSession } from "@git-workbench/shared"
import type { Handle } from "remix/ui"
import { errorMessage, FatalError, Notice, type NoticeState } from "./feedback"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry"
import { createGitSettings, type GitSettings } from "./settings"
import { RepositoryView, Welcome, WorkbenchHeader } from "./workspace"

type AppState = Awaited<ReturnType<Window["workbench"]["getState"]>>

export function WorkbenchApp(handle: Handle<{ api: Window["workbench"] }>) {
    let initial: AppState | undefined
    let session: WorkbenchSession | undefined
    let repositoryEntry: RepositoryEntry | undefined
    let gitSettings: GitSettings | undefined
    let openingRepository = false
    let notice: NoticeState | undefined
    let fatalError: string | undefined
    let showWelcome = false

    handle.queueTask(() => void bootstrap())
    handle.signal.addEventListener("abort", () => document.body.classList.remove("busy"), { once: true })

    return () => {
        if (!initial || !session || !repositoryEntry || !gitSettings) {
            return fatalError
                ? <FatalError message={fatalError} retry={bootstrap} />
                : <main class="bootstrap-state" aria-live="polite"><p>Starting Git Workbench…</p></main>
        }

        const currentSession = session
        const active = currentSession.repositories.find(repository => repository.id == currentSession.activeRepositoryId)
        const busy = openingRepository || repositoryEntry.busy
        return <>
            <main class="shell">
                <WorkbenchHeader
                    settings={gitSettings.current}
                    busy={busy}
                    home={() => {
                        showWelcome = true
                        handle.update()
                    }}
                    openSettings={gitSettings.open}
                />
                {active && !showWelcome
                    ? (
                        <RepositoryView
                            active={active}
                            session={currentSession}
                            busy={busy}
                            selectRepository={selectRepository}
                            openRepository={openRepository}
                            openClone={repositoryEntry.openClone}
                            openInitialize={repositoryEntry.openInitialize}
                        />
                    )
                    : (
                        <Welcome
                            settings={gitSettings.current}
                            busy={busy}
                            openRepository={openRepository}
                            openClone={repositoryEntry.openClone}
                            openInitialize={repositoryEntry.openInitialize}
                        />
                    )}
                <footer><span>System Git</span><i></i><span>{initial.engine.state == "ready" ? `Engine ${initial.engine.version}` : "Engine unavailable"}</span></footer>
            </main>
            {repositoryEntry.render()}
            {gitSettings.render()}
            <Notice notice={notice} dismiss={() => {
                notice = undefined
                handle.update()
            }} />
        </>
    }

    async function bootstrap() {
        fatalError = undefined
        await handle.update()
        try {
            initial = await handle.props.api.getState()
            session = initial.session
            gitSettings = createGitSettings({
                api: handle.props.api,
                initial: initial.settings,
                update: handle.update,
                notify,
            })
            repositoryEntry = createRepositoryEntry({
                api: handle.props.api,
                defaultCloneParent: initial.defaultCloneParent,
                update: handle.update,
                notify,
                sessionOpened(nextSession) {
                    session = nextSession
                    showWelcome = false
                },
            })
            const unsubscribe = handle.props.api.onEntryProgress(updateProgress)
            handle.signal.addEventListener("abort", unsubscribe, { once: true })
        } catch (error) {
            fatalError = errorMessage(error)
        }
        await handle.update()
    }

    function updateProgress(progress: EntryProgress) {
        repositoryEntry?.updateProgress(progress)
    }

    function notify(nextNotice: NoticeState) {
        notice = nextNotice
    }

    async function setOpeningRepository(value: boolean) {
        openingRepository = value
        document.body.classList.toggle("busy", value)
        await handle.update()
    }

    async function openRepository() {
        await setOpeningRepository(true)
        try {
            const result = await handle.props.api.openRepository()
            if (result.ok) {
                session = result.session
                showWelcome = false
                notify({ code: "repository.opened", message: "Repository opened." })
            } else if (result.error.code != "git.cancelled") {
                notify({ code: result.error.code, message: result.error.message })
            }
        } catch (error) {
            notify({ code: "repository.open.failed", message: errorMessage(error) })
        } finally {
            await setOpeningRepository(false)
        }
    }

    async function selectRepository(id: string) {
        await setOpeningRepository(true)
        try {
            session = await handle.props.api.selectRepository(id)
            showWelcome = false
        } catch (error) {
            notify({ code: "repository.select.failed", message: errorMessage(error) })
        } finally {
            await setOpeningRepository(false)
        }
    }
}
