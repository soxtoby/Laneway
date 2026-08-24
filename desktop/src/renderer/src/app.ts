import type { EngineMessage } from "@git-workbench/shared"
import "./styles.css"

const app = document.querySelector<HTMLDivElement>("#app")
if (!app)
    throw new Error("Workbench root element was not found.")

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <div class="brand" aria-label="Git Workbench">
        <span class="brand-mark" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
        <div>
          <p class="eyebrow">Local Git instrument</p>
          <h1>Workbench</h1>
        </div>
      </div>
      <div class="engine-badge" id="engine-badge" role="status" aria-live="polite">
        <span class="status-light" aria-hidden="true"></span>
        <span id="engine-summary">Locating Engine</span>
      </div>
    </header>

    <section class="workspace" aria-labelledby="command-heading">
      <div class="command-panel">
        <div class="section-index" aria-hidden="true">01</div>
        <div class="section-heading">
          <p class="eyebrow">Process-per-command test bench</p>
          <h2 id="command-heading">Ask the Engine to echo</h2>
          <p>
            A harmless round trip through the same executable boundary used by every
            future Workbench operation.
          </p>
        </div>

        <form id="echo-form">
          <label for="repository-path">Target repository</label>
          <div class="path-field">
            <span aria-hidden="true">cwd</span>
            <input id="repository-path" name="repositoryPath" spellcheck="false" required />
          </div>

          <label for="echo-message">Payload</label>
          <textarea id="echo-message" name="message" rows="3">Workbench online.</textarea>

          <div class="controls">
            <button class="run-button" id="run-button" type="submit">
              <span>Run echo</span>
              <kbd>Enter</kbd>
            </button>
            <button class="cancel-button" id="cancel-button" type="button" disabled>
              Cancel process
            </button>
          </div>
        </form>

        <dl class="engine-detail">
          <div>
            <dt>Executable</dt>
            <dd id="engine-path">Checking...</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd id="engine-version">Checking...</dd>
          </div>
        </dl>
      </div>

      <div class="trace-panel">
        <div class="trace-heading">
          <div>
            <p class="eyebrow">Structured output</p>
            <h2>Engine trace</h2>
          </div>
          <span class="format-tag">NDJSON</span>
        </div>

        <progress
          class="progress-track"
          id="progress"
          max="1"
          value="0"
          aria-label="Engine command progress"
        ></progress>

        <ol id="trace" class="trace" aria-live="polite" aria-label="Engine events">
          <li class="empty-trace">
            <span>00</span>
            Ready for a command.
          </li>
        </ol>

        <div id="result" class="result" role="status" aria-live="polite">
          <span class="result-label">Result</span>
          <strong id="result-text">No result yet</strong>
        </div>
      </div>
    </section>

    <footer>
      <span>Workbench GUI</span>
      <span class="footer-rule"></span>
      <span>Engine runs out of process</span>
    </footer>
  </main>
`

const form = document.querySelector<HTMLFormElement>("#echo-form")!
const repositoryPath = document.querySelector<HTMLInputElement>("#repository-path")!
const echoMessage = document.querySelector<HTMLTextAreaElement>("#echo-message")!
const runButton = document.querySelector<HTMLButtonElement>("#run-button")!
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel-button")!
const engineBadge = document.querySelector<HTMLDivElement>("#engine-badge")!
const engineSummary = document.querySelector<HTMLSpanElement>("#engine-summary")!
const enginePath = document.querySelector<HTMLElement>("#engine-path")!
const engineVersion = document.querySelector<HTMLElement>("#engine-version")!
const trace = document.querySelector<HTMLOListElement>("#trace")!
const progress = document.querySelector<HTMLProgressElement>("#progress")!
const result = document.querySelector<HTMLDivElement>("#result")!
const resultText = document.querySelector<HTMLElement>("#result-text")!

let traceIndex = 0

function setRunning(running: boolean) {
    runButton.disabled = running
    cancelButton.disabled = !running
    form.setAttribute("aria-busy", String(running))
}

function resetTrace() {
    traceIndex = 0
    trace.replaceChildren()
    progress.value = 0
    result.className = "result"
    resultText.textContent = "Command in progress"
}

function appendTrace(message: EngineMessage) {
    traceIndex += 1
    const item = document.createElement("li")
    const index = document.createElement("span")
    const body = document.createElement("div")
    const type = document.createElement("small")
    const text = document.createElement("p")

    index.textContent = String(traceIndex).padStart(2, "0")
    type.textContent = message.type
    text.textContent = describeEngineMessage(message)
    body.append(type, text)
    item.append(index, body)
    item.dataset.type = message.type
    trace.append(item)

    if (message.type === "progress")
        progress.value = message.completed / message.total
    else if (message.type === "result") {
        progress.value = 1
        result.classList.add("is-success")
        resultText.textContent = message.command === "echo" ? message.message : "Command completed"
    } else if (message.type === "cancelled") {
        result.classList.add("is-cancelled")
        resultText.textContent = message.message
    } else {
        result.classList.add("is-error")
        resultText.textContent = `${message.code}: ${message.message}`
    }

    item.scrollIntoView({ block: "nearest" })
}

function describeEngineMessage(message: EngineMessage) {
    if ("message" in message)
        return message.message
    if (message.command == "git-smoke")
        return `${message.gitVersion} at ${message.repositoryRoot}`
    if (message.command == "history")
        return `${message.total} Workbench Operations`
    if (message.command == "test-mutation")
        return message.operation.summary
    if (message.command == "recover")
        return message.status == "clean" ? "No recovery required" : `Recovered ${message.recovered.length} operation(s)`
    return message.operation?.summary ?? `Nothing to ${message.command}`
}

window.workbench.onEngineMessage(appendTrace)

const status = await window.workbench.getEngineStatus()
repositoryPath.value = status.repositoryPath
enginePath.textContent = status.path
enginePath.title = status.path

if (status.state === "ready") {
    engineBadge.classList.add("is-ready")
    engineSummary.textContent = `${status.name} ${status.version}`
    engineVersion.textContent = status.version
} else {
    engineBadge.classList.add("is-error")
    engineSummary.textContent = "Engine unavailable"
    engineVersion.textContent = "Unavailable"
    result.classList.add("is-error")
    resultText.textContent = status.error
    runButton.disabled = true
}

form.addEventListener("submit", async event => {
    event.preventDefault()
    resetTrace()
    setRunning(true)

    try {
        const command = window.workbench.runEcho(echoMessage.value, repositoryPath.value)
        const execution = await command

        if (execution.exitCode !== 0 && execution.exitCode !== 3) {
            result.classList.add("is-error")
            resultText.textContent = execution.diagnostics || `Engine exited ${execution.exitCode}.`
        }
    } catch (error) {
        result.classList.add("is-error")
        resultText.textContent = error instanceof Error ? error.message : String(error)
    } finally {
        setRunning(false)
    }
})

cancelButton.addEventListener("click", async () => {
    const cancelled = await window.workbench.cancel()
    if (cancelled) {
        cancelButton.disabled = true
        result.classList.add("is-cancelled")
        resultText.textContent = "Stopping..."
    }
})
