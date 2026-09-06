import { createRoot } from "remix/ui"
import { WorkbenchApp } from "../../src/renderer/src/app"
import { inspectionScenario } from "../renderer-fixtures"

async function checkRenderer() {
    const violations: string[] = []
    document.addEventListener("securitypolicyviolation", event => violations.push(`${event.violatedDirective}: ${event.blockedURI}`))
    const scenario = inspectionScenario()
    scenario.page.file.path = "src/example.ts"
    scenario.page.lines[1].text = "const oldValue = 1"
    scenario.page.lines[2].text = "const newValue = 2"
    const readHistory = scenario.api.readBranchHistory
    scenario.api.readBranchHistory = async (...args) => {
        const result = await readHistory(...args)
        if (result.ok)
            result.page.commits.push({ ...result.page.commits[0], objectId: "4".repeat(40), subject: "Another change" })
        return result
    }
    scenario.page.lines.push({ id: 3, kind: "notice", text: "\\ No newline at end of file", hunk: 0 })
    const root = createRoot(document.querySelector<HTMLElement>("#app")!)
    root.render(<WorkbenchApp api={scenario.api} />)

    async function settle() {
        for (let index = 0; index < 8; index++) {
            await new Promise(resolve => setTimeout(resolve, 0))
            root.flush()
        }
    }
    function element<T extends HTMLElement = HTMLElement>(selector: string) {
        const node = document.querySelector<T>(selector)
        if (!node)
            throw new Error(`Missing ${selector}`)
        return node
    }
    function press(node: HTMLElement, key: string) {
        node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    }
    await settle()
    element(".change-file button").click()
    await settle()
    const diffShadow = element(".pierre-diff").shadowRoot!
    const deletion = diffShadow.querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!
    deletion.click()
    await settle()
    const literalSelection = diffShadow.querySelectorAll(".diff-line.selected").length == 1
        && !diffShadow.querySelector(".addition.selected")
    const splitButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() == "Side by side")!
    splitButton.click()
    await settle()
    const oldLine = diffShadow.querySelector<HTMLElement>("[data-deletions] [data-line]")!
    const newLine = diffShadow.querySelector<HTMLElement>("[data-additions] [data-line]")!
    const alignedSplit = oldLine.getBoundingClientRect().top == newLine.getBoundingClientRect().top
        && newLine.getBoundingClientRect().left > oldLine.getBoundingClientRect().left
    const diffLineHeight = oldLine.getBoundingClientRect().height
    // Highlighting completes asynchronously after the initial plain render.
    for (let attempt = 0; attempt < 50 && !diffShadow.querySelector("[data-line] span[style]"); attempt++)
        await new Promise(resolve => setTimeout(resolve, 20))
    const syntaxHighlighted = !!diffShadow.querySelector("[data-line] span[style]")
    const noticePosition = getComputedStyle(element(".diff-line.notice")).position
    const rowHeight = element(".diff-line.notice").getBoundingClientRect().height
    const lightBackground = getComputedStyle(element(".diff-inspector")).backgroundColor
    element("button[aria-label='Switch to dark appearance']").click()
    await settle()
    const darkBackground = getComputedStyle(element(".diff-inspector")).backgroundColor

    element(".stack-heading:not(:disabled)").click()
    await settle()
    const branchTrigger = element(".stack-heading:not(:disabled)")
    const branchPanel = element(`#${CSS.escape(branchTrigger.getAttribute("aria-controls")!)}`)
    const branchExpanded = branchTrigger.getAttribute("aria-expanded") == "true" && !branchPanel.hidden
    element(".commit-heading").click()
    await settle()
    const commitTrigger = element(".commit-heading")
    const commitPanel = element(`#${CSS.escape(commitTrigger.getAttribute("aria-controls")!)}`)
    const commitExpanded = commitTrigger.getAttribute("aria-expanded") == "true" && !commitPanel.hidden
    commitTrigger.focus()
    press(commitTrigger, "ArrowDown")
    const accordionKeyboard = document.activeElement == document.querySelectorAll(".commit-heading")[1]
    commitTrigger.click()
    await settle()
    const commitCollapsed = commitTrigger.getAttribute("aria-expanded") == "false" && commitPanel.hidden

    element("button[aria-label='Branch Graph settings']").click()
    await settle()
    const radio = element<HTMLInputElement>("input[type='radio']")
    const radioChecked = radio.checked && radio.getBoundingClientRect().width > 0
    const radioBackground = getComputedStyle(radio).backgroundColor

    element(".lens-button").focus()
    element(".lens-button").click()
    await settle()
    const search = element<HTMLInputElement>(".command-lens input")
    const modal = element<HTMLDialogElement>("dialog.lens-backdrop").matches(":modal")
    search.value = "e"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    const firstActive = search.getAttribute("aria-activedescendant")
    press(search, "ArrowDown")
    await settle()
    const secondActive = search.getAttribute("aria-activedescendant")
    const navigated = firstActive != secondActive && !!secondActive && element(`#${CSS.escape(secondActive)}`).getAttribute("data-highlighted") == "true"
    const searchKeptFocus = document.activeElement == search
    search.value = "not-a-repository"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    const emptyCleared = !search.hasAttribute("aria-activedescendant") && search.getAttribute("aria-expanded") == "false"
    press(search, "Escape")
    await settle()
    const restoredFocus = document.activeElement == element(".lens-button")
    element(".lens-button").click()
    await settle()
    const reopenedSearch = element<HTMLInputElement>(".command-lens input")
    reopenedSearch.value = "feature/workbench"
    reopenedSearch.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    const columnCount = document.querySelectorAll(".branch-column").length
    press(reopenedSearch, "Enter")
    await settle()
    const activatedBranch = !document.querySelector(".command-lens")
        && element(".graph-row.selected").dataset.nodeId == "branch:refs/heads/feature/workbench"
        && document.querySelectorAll(".branch-column").length == columnCount
    const stylesheets = document.adoptedStyleSheets.length
    root.dispose()
    return {
        noticePosition,
        literalSelection,
        alignedSplit,
        diffLineHeight,
        syntaxHighlighted,
        rowHeight,
        lightBackground,
        darkBackground,
        branchExpanded,
        commitExpanded,
        commitCollapsed,
        accordionKeyboard,
        radioChecked,
        radioBackground,
        modal,
        navigated,
        searchKeptFocus,
        emptyCleared,
        restoredFocus,
        activatedBranch,
        stylesheets,
        violations,
    }
}

Object.assign(window, { rendererChecks: checkRenderer() })
