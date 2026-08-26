import type { EntryError, EntryResult, RepositoryInfo } from "@git-workbench/shared"

if (!window.workbench && import.meta.env.DEV)
    await import("./browser-workbench")

const app = document.querySelector<HTMLDivElement>("#app")
if (!app)
    throw new Error("Workbench root element was not found.")

const initial = await window.workbench.getState()
let session = initial.session
let settings = initial.settings
let busy = false
let destinationEdited = false

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <button class="brand" id="home-button" type="button" aria-label="Git Workbench home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span><small>Git Workbench</small><strong>Repository desk</strong></span>
      </button>
      <div class="header-actions">
        <span class="git-badge" id="git-badge"><i></i><span>Checking Git</span></span>
        <button class="icon-button" id="settings-button" type="button" aria-label="Git settings" title="Git settings">⌘</button>
      </div>
    </header>

    <section class="workspace" id="workspace" aria-live="polite"></section>

    <footer>
      <span>System Git</span><i></i><span id="footer-engine"></span>
    </footer>
  </main>

  <dialog id="clone-dialog" aria-labelledby="clone-heading">
    <form id="clone-form" class="entry-form">
      <header><span class="sequence">02</span><div><p class="eyebrow">Bring work in</p><h2 id="clone-heading">Clone repository</h2></div></header>
      <label for="clone-source">Git source</label>
      <input id="clone-source" name="source" autocomplete="off" spellcheck="false" placeholder="https://host/team/repository.git" required />
      <label for="clone-destination">Destination</label>
      <div class="field-with-action">
        <input id="clone-destination" name="destination" autocomplete="off" spellcheck="false" required />
        <button id="clone-browse" type="button">Browse</button>
      </div>
      <div class="progress-block" id="clone-progress" hidden><span></span><p>Starting Git</p></div>
      <div class="form-error" id="clone-error" role="alert" hidden></div>
      <footer class="dialog-actions">
        <button class="text-button" data-close="clone-dialog" type="button">Cancel</button>
        <button class="primary-button" type="submit">Clone and open</button>
      </footer>
    </form>
  </dialog>

  <dialog id="init-dialog" aria-labelledby="init-heading">
    <form id="init-form" class="entry-form">
      <header><span class="sequence">03</span><div><p class="eyebrow">Start local</p><h2 id="init-heading">Initialise repository</h2></div></header>
      <label for="init-path">Directory</label>
      <div class="field-with-action">
        <input id="init-path" name="path" autocomplete="off" spellcheck="false" required />
        <button id="init-browse" type="button">Browse</button>
      </div>
      <label for="init-branch">Initial branch <span>optional</span></label>
      <input id="init-branch" name="branch" autocomplete="off" spellcheck="false" placeholder="Use system Git default" />
      <p class="field-note">Existing files stay untouched. Git creates only its repository data.</p>
      <div class="form-error" id="init-error" role="alert" hidden></div>
      <footer class="dialog-actions">
        <button class="text-button" data-close="init-dialog" type="button">Cancel</button>
        <button class="primary-button" type="submit">Initialise and open</button>
      </footer>
    </form>
  </dialog>

  <dialog id="settings-dialog" aria-labelledby="settings-heading">
    <section class="settings-panel">
      <header><span class="sequence">CFG</span><div><p class="eyebrow">Application setting</p><h2 id="settings-heading">System Git</h2></div></header>
      <div id="settings-content"></div>
      <footer class="dialog-actions">
        <button class="text-button" data-close="settings-dialog" type="button">Close</button>
        <button class="secondary-button" id="use-path-button" type="button">Use Git from PATH</button>
        <button class="primary-button" id="choose-git-button" type="button">Choose executable</button>
      </footer>
    </section>
  </dialog>

  <div class="notice" id="notice" role="status" aria-live="polite" hidden>
    <div><small id="notice-code"></small><p id="notice-message"></p></div>
    <button id="notice-action" type="button" hidden></button>
    <button id="notice-close" type="button" aria-label="Dismiss">×</button>
  </div>
`

const workspace = required<HTMLElement>("#workspace")
const gitBadge = required<HTMLElement>("#git-badge")
const settingsDialog = required<HTMLDialogElement>("#settings-dialog")
const cloneDialog = required<HTMLDialogElement>("#clone-dialog")
const initDialog = required<HTMLDialogElement>("#init-dialog")
const cloneForm = required<HTMLFormElement>("#clone-form")
const initForm = required<HTMLFormElement>("#init-form")
const cloneSource = required<HTMLInputElement>("#clone-source")
const cloneDestination = required<HTMLInputElement>("#clone-destination")
const initPath = required<HTMLInputElement>("#init-path")
const initBranch = required<HTMLInputElement>("#init-branch")
const cloneProgress = required<HTMLElement>("#clone-progress")
const footerEngine = required<HTMLElement>("#footer-engine")

footerEngine.textContent = initial.engine.state == "ready"
    ? `Engine ${initial.engine.version}`
    : "Engine unavailable"

render()

window.workbench.onEntryProgress(progress => {
    cloneProgress.hidden = false
    cloneProgress.querySelector("p")!.textContent = progress.message
})

required("#settings-button").addEventListener("click", () => {
    renderSettings()
    settingsDialog.showModal()
})
required("#home-button").addEventListener("click", () => renderWelcome())
required("#clone-browse").addEventListener("click", async () => {
    const selected = await window.workbench.chooseDirectory(cloneDestination.value || initial.defaultCloneParent)
    if (selected) {
        cloneDestination.value = selected
        destinationEdited = true
    }
})
required("#init-browse").addEventListener("click", async () => {
    const selected = await window.workbench.chooseDirectory(initPath.value || initial.defaultCloneParent)
    if (selected)
        initPath.value = selected
})

cloneSource.addEventListener("input", async () => {
    if (!destinationEdited)
        cloneDestination.value = await window.workbench.suggestCloneDestination(cloneSource.value, initial.defaultCloneParent)
})
cloneDestination.addEventListener("input", () => destinationEdited = true)

cloneForm.addEventListener("submit", async event => {
    event.preventDefault()
    setBusy(true)
    showFormError("clone", undefined)
    cloneProgress.hidden = false
    cloneProgress.querySelector("p")!.textContent = "Starting Git"
    const result = await window.workbench.cloneRepository(cloneSource.value, cloneDestination.value)
    setBusy(false)
    handleEntryResult(result, cloneDialog, "clone")
})

initForm.addEventListener("submit", async event => {
    event.preventDefault()
    setBusy(true)
    showFormError("init", undefined)
    const result = await window.workbench.initializeRepository(initPath.value, initBranch.value || undefined)
    setBusy(false)
    handleEntryResult(result, initDialog, "init")
})

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
    button.addEventListener("click", async () => {
        if (busy && button.dataset.close == "clone-dialog") {
            await window.workbench.cancelEntry()
            cloneProgress.querySelector("p")!.textContent = "Stopping Git"
            return
        }
        required<HTMLDialogElement>(`#${button.dataset.close}`).close()
    })
}

required("#choose-git-button").addEventListener("click", async () => {
    settings = await window.workbench.chooseGit()
    renderSettings()
    renderGitBadge()
})
required("#use-path-button").addEventListener("click", async () => {
    settings = await window.workbench.useGitFromPath()
    renderSettings()
    renderGitBadge()
})
required("#notice-close").addEventListener("click", hideNotice)

function render() {
    renderGitBadge()
    const active = session.repositories.find(repository => repository.id == session.activeRepositoryId)
    if (active)
        renderRepository(active)
    else
        renderWelcome()
}

function renderWelcome() {
    workspace.className = "workspace welcome"
    workspace.innerHTML = `
      <section class="welcome-copy">
        <p class="eyebrow">Repository entry</p>
        <h1>Put a line of work<br />on the bench.</h1>
        <p>Open an exact Git root, bring down a remote, or initialise work already on disk.</p>
        <div class="git-readout">${gitReadout()}</div>
      </section>
      <section class="entry-grid" aria-label="Repository entry actions">
        ${entryCard("01", "Open", "Existing repository", "Choose the root of a Main or linked worktree.", "open-action")}
        ${entryCard("02", "Clone", "Remote or local source", "Use your system credentials, SSH agent, filters, and hooks.", "clone-action")}
        ${entryCard("03", "Initialise", "Directory on disk", "Keep existing files and let system Git create the repository.", "init-action")}
      </section>
    `
    bindEntryActions()
}

function renderRepository(active: RepositoryInfo) {
    workspace.className = "workspace repository-view"
    workspace.innerHTML = `
      <aside class="repository-rail">
        <div class="rail-heading"><p class="eyebrow">Session</p><span>${session.repositories.length}</span></div>
        <nav aria-label="Open repositories">
          ${
        session.repositories.map(repository => `
            <button class="repository-item ${repository.id == active.id ? "active" : ""}" data-repository-id="${escapeAttribute(repository.id)}" type="button">
              <span>${initials(repository.mainWorktree)}</span>
              <span><strong>${escapeHtml(baseName(repository.mainWorktree))}</strong><small>${escapeHtml(repository.selectedWorktree)}</small></span>
            </button>
          `).join("")
    }
        </nav>
        <div class="rail-actions">
          <button id="open-action" type="button">Open</button>
          <button id="clone-action" type="button">Clone</button>
          <button id="init-action" type="button">Init</button>
        </div>
      </aside>
      <section class="repository-shell">
        <div class="repository-kicker"><span class="pulse"></span>Repository ready</div>
        <h1>${escapeHtml(baseName(active.mainWorktree))}</h1>
        <p class="repository-path">${escapeHtml(active.selectedWorktree)}</p>
        <div class="fact-grid">
          ${fact("Selected worktree", active.selectedWorktree)}
          ${fact("Main Worktree", active.mainWorktree)}
          ${fact("Object format", active.objectFormat.toUpperCase())}
          ${fact("System Git", `${active.git.version} · ${active.git.path}`)}
        </div>
        <div class="shape-flags">
          ${active.shallow ? "<span>Shallow</span>" : ""}
          ${active.partial ? "<span>Partial clone</span>" : ""}
          ${active.sparse ? "<span>Sparse checkout</span>" : ""}
          ${!active.shallow && !active.partial && !active.sparse ? "<span>Full repository</span>" : ""}
        </div>
        <div class="next-module"><span>Next module</span><p>Repository evidence and the Branch Graph arrive in SOX-131.</p></div>
      </section>
    `
    bindEntryActions()
    for (const button of workspace.querySelectorAll<HTMLButtonElement>("[data-repository-id]")) {
        button.addEventListener("click", async () => {
            session = await window.workbench.selectRepository(button.dataset.repositoryId!)
            render()
        })
    }
}

function bindEntryActions() {
    workspace.querySelector("#open-action")?.addEventListener("click", openSelectedRepository)
    workspace.querySelector("#clone-action")?.addEventListener("click", () => {
        destinationEdited = false
        cloneSource.value = ""
        cloneDestination.value = ""
        cloneProgress.hidden = true
        showFormError("clone", undefined)
        cloneDialog.showModal()
        cloneSource.focus()
    })
    workspace.querySelector("#init-action")?.addEventListener("click", () => {
        initPath.value = ""
        initBranch.value = ""
        showFormError("init", undefined)
        initDialog.showModal()
    })
}

async function openSelectedRepository() {
    setBusy(true)
    const result = await window.workbench.openRepository()
    setBusy(false)
    if (result.ok) {
        session = result.session
        render()
        showNotice("repository.opened", "Repository opened.")
    } else if (result.error.code != "git.cancelled") {
        showEntryError(result.error)
    }
}

function handleEntryResult(result: EntryResult, dialog: HTMLDialogElement, form: "clone" | "init") {
    if (result.ok) {
        session = result.session
        dialog.close()
        if (form == "clone") {
            cloneSource.value = ""
            cloneDestination.value = ""
        }
        render()
        showNotice(`repository.${form == "clone" ? "cloned" : "initialised"}`, `Repository ${form == "clone" ? "cloned" : "initialised"} and opened.`)
        return
    }
    showFormError(form, result.error)
    if (result.error.canRemoveDestination)
        showEntryError(result.error)
}

function showFormError(form: "clone" | "init", error?: EntryError) {
    const element = required<HTMLElement>(`#${form}-error`)
    element.hidden = !error
    element.textContent = error?.message ?? ""
}

function showEntryError(error: EntryError) {
    showNotice(error.code, error.message, error.canRemoveDestination ? "Remove partial clone" : undefined, async () => {
        if (await window.workbench.removePartialClone())
            showNotice("clone.cleaned", "Partial clone removed.")
    })
}

function showNotice(code: string, message: string, action?: string, callback?: () => void | Promise<void>) {
    const notice = required<HTMLElement>("#notice")
    required<HTMLElement>("#notice-code").textContent = code
    required<HTMLElement>("#notice-message").textContent = message
    const actionButton = required<HTMLButtonElement>("#notice-action")
    actionButton.hidden = !action
    actionButton.textContent = action ?? ""
    actionButton.onclick = callback ?? null
    notice.hidden = false
}

function hideNotice() {
    required<HTMLElement>("#notice").hidden = true
}

function renderSettings() {
    const content = required<HTMLElement>("#settings-content")
    if (settings.error) {
        content.innerHTML = `<div class="settings-error"><strong>${escapeHtml(settings.error.code)}</strong><p>${
            escapeHtml(settings.error.message)
        }</p><div><button id="open-settings-file" type="button">Open settings file</button><button id="reset-settings-button" type="button">Reset settings</button></div></div>`
        content.querySelector<HTMLButtonElement>("#open-settings-file")?.addEventListener("click", async () => {
            const error = await window.workbench.openSettingsFile()
            if (error)
                showNotice("settings.open-failed", error)
        })
        content.querySelector<HTMLButtonElement>("#reset-settings-button")?.addEventListener("click", async () => {
            settings = await window.workbench.resetSettings()
            renderSettings()
            renderGitBadge()
        })
        return
    }
    content.innerHTML = `
      <dl class="settings-facts">
        <div><dt>Executable</dt><dd>${escapeHtml(settings.git?.path ?? "Unavailable")}</dd></div>
        <div><dt>Version</dt><dd>${escapeHtml(settings.git?.version ?? "Unavailable")}</dd></div>
        <div><dt>Selection</dt><dd>${settings.override ? "Application override" : "PATH"}</dd></div>
        <div><dt>Settings file</dt><dd>${escapeHtml(settings.path)}</dd></div>
      </dl>
    `
}

function renderGitBadge() {
    gitBadge.classList.toggle("error", Boolean(settings.error))
    gitBadge.querySelector("span")!.textContent = settings.git ? `Git ${settings.git.version}` : "Git unavailable"
}

function setBusy(value: boolean) {
    busy = value
    document.body.classList.toggle("busy", value)
    for (const button of document.querySelectorAll<HTMLButtonElement>("button")) {
        if (button.id == "notice-close" || button.dataset.close == "clone-dialog")
            continue
        button.disabled = value
    }
}

function entryCard(sequence: string, title: string, label: string, description: string, id: string) {
    return `<button class="entry-card" id="${id}" type="button"><span class="sequence">${sequence}</span><span><small>${label}</small><strong>${title}</strong><p>${description}</p></span><i aria-hidden="true">↗</i></button>`
}

function gitReadout() {
    if (settings.error)
        return `<span class="pulse error"></span><span>Git unavailable</span>`
    return `<span class="pulse"></span><span>${escapeHtml(settings.git?.path ?? "Git unavailable")}</span><strong>${
        escapeHtml(settings.git?.version ?? "")
    }</strong>`
}

function fact(label: string, value: string) {
    return `<div><dt>${label}</dt><dd title="${escapeAttribute(value)}">${escapeHtml(value)}</dd></div>`
}

function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

function initials(path: string) {
    const words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!)
}

function escapeAttribute(value: string) {
    return escapeHtml(value)
}

function required<T extends Element = HTMLElement>(selector: string) {
    const element = document.querySelector<T>(selector)
    if (!element)
        throw new Error(`Missing Workbench element: ${selector}`)
    return element
}
