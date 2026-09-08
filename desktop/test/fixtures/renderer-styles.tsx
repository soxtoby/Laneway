import { createRoot } from "remix/ui"
import { WorkbenchApp } from "../../src/renderer/src/app"
import { inspectionScenario } from "../renderer-fixtures"
import { checkBranchGraphScroll } from "./branch-graph-scroll"

async function checkRenderer() {
    const violations: string[] = []
    document.addEventListener("securitypolicyviolation", event => violations.push(`${event.violatedDirective}: ${event.blockedURI}`))
    const scenario = inspectionScenario()
    const readGraph = scenario.api.readBranchGraph
    scenario.api.readBranchGraph = async (...args) => {
        const result = await readGraph(...args)
        if (result.ok) {
            const [main, feature] = result.graph.branches
            result.graph.tags = [{ kind: "tag", id: "tag:waypoint", name: "waypoint", objectId: "tagged", parentBranchId: feature.id, tooltip: "Tag waypoint" }]
            result.graph.history = [{ objectId: feature.tip, lineId: feature.id, parentIds: ["tagged"] }, {
                objectId: "tagged",
                lineId: feature.id,
                parentIds: [main.tip],
            }, { objectId: main.tip, lineId: main.id, parentIds: [] }]
        }
        return result
    }
    scenario.page.summary = ["File deleted"]
    scenario.page.file.path = "src/example.ts"
    scenario.page.lines[1].text = `\tconst oldValue = 1 // ${"old content ".repeat(30)}`
    scenario.page.lines[2].text = `\tconst newValue = 2 // ${"new content ".repeat(60)}`
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
    const graphRows = [...document.querySelectorAll<HTMLElement>(".graph-row")]
    const branchGraphConnected = graphRows.length == 3 && graphRows.every((row, index) => {
        const rail = row.querySelector("svg")!
        return rail.getBoundingClientRect().top == row.getBoundingClientRect().top
            && rail.getBoundingClientRect().height == 40
            && (index == 0 || graphRows[index - 1].getBoundingClientRect().bottom == row.getBoundingClientRect().top)
            && rail.querySelectorAll("path").length > 0
    }) && graphRows[0].querySelector("circle")!.getAttribute("cx") != graphRows[2].querySelector("circle")!.getAttribute("cx")
    const graphColors = () => [...document.querySelectorAll(".graph-row circle")].map(node => getComputedStyle(node).stroke)
    const lightGraphColors = graphColors()
    const branchGraphColors = lightGraphColors[0] == lightGraphColors[1] && lightGraphColors[0] != lightGraphColors[2]
        && new Set([...graphRows[0].querySelectorAll("path")].map(path => getComputedStyle(path).stroke)).size == 2
    element(".change-file button").click()
    await settle()
    const diffShadow = element(".pierre-diff").shadowRoot!
    const metadata = element(".diff-summary")
    const metadataStyle = getComputedStyle(metadata)
    const balancedMetadata = metadataStyle.paddingTop == metadataStyle.paddingBottom
        && Math.abs(metadata.getBoundingClientRect().bottom - diffShadow.querySelector("[data-separator]")!.getBoundingClientRect().top) <= 1
    const deletion = diffShadow.querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!
    deletion.click()
    await settle()
    const literalSelection = diffShadow.querySelectorAll(".diff-line.selected").length == 1
        && !diffShadow.querySelector(".addition.selected")
    const splitButton = element<HTMLButtonElement>("[aria-label='Side by side']")
    splitButton.click()
    await settle()
    const oldLine = diffShadow.querySelector<HTMLElement>("[data-deletions] [data-line]")!
    const newLine = diffShadow.querySelector<HTMLElement>("[data-additions] [data-line]")!
    const alignedSplit = oldLine.getBoundingClientRect().top == newLine.getBoundingClientRect().top
        && newLine.getBoundingClientRect().left > oldLine.getBoundingClientRect().left
    const diffLineHeight = oldLine.getBoundingClientRect().height
    const leftPane = diffShadow.querySelector<HTMLElement>("[data-deletions]")!
    const rightPane = diffShadow.querySelector<HTMLElement>("[data-additions]")!
    leftPane.scrollLeft = 100
    leftPane.dispatchEvent(new Event("scroll"))
    const linkedFromLeft = leftPane.scrollLeft == 100 && rightPane.scrollLeft == 100
    rightPane.scrollLeft = 200
    rightPane.dispatchEvent(new Event("scroll"))
    const linkedFromRight = leftPane.scrollLeft == 200 && rightPane.scrollLeft == 200
    rightPane.scrollLeft = rightPane.scrollWidth
    rightPane.dispatchEvent(new Event("scroll"))
    const widerOffset = rightPane.scrollLeft
    leftPane.dispatchEvent(new Event("scroll"))
    const unequalWidthsStable = widerOffset > leftPane.scrollLeft && rightPane.scrollLeft == widerOffset
    leftPane.scrollLeft = 100
    leftPane.dispatchEvent(new Event("scroll"))
    // Highlighting completes asynchronously after the initial plain render.
    for (let attempt = 0; attempt < 50 && !diffShadow.querySelector("[data-line] span[style]"); attempt++)
        await new Promise(resolve => setTimeout(resolve, 20))
    const syntaxHighlighted = !!diffShadow.querySelector("[data-line] span[style]")
    const intraLineHighlight = [...diffShadow.querySelectorAll("[data-line] [data-diff-span]")].some(span => {
        const text = span.textContent ?? ""
        return text.length > 0 && text.length < 10 && getComputedStyle(span).backgroundColor != "rgba(0, 0, 0, 0)"
    })
    const whitespaceToggle = element<HTMLButtonElement>("[aria-label='Show whitespace']")
    const whitespaceDefaultOff = whitespaceToggle.getAttribute("aria-pressed") == "false" && !diffShadow.querySelector("[data-whitespace]")
    const originalLine = diffShadow.querySelector("[data-line]")!.textContent
    whitespaceToggle.click()
    await settle()
    const whitespaceVisible = whitespaceToggle.getAttribute("aria-pressed") == "true"
        && !!diffShadow.querySelector("[data-whitespace=space]") && !!diffShadow.querySelector("[data-whitespace=tab]")
        && diffShadow.querySelector("[data-line]")!.textContent == originalLine
        && diffShadow.querySelectorAll(".diff-line.selected").length == 1
    const lineEndingsVisible = !!diffShadow.querySelector("[data-deletions] [data-whitespace=line-ending]")
        && !diffShadow.querySelector("[data-additions] [data-whitespace=line-ending]")
    whitespaceToggle.click()
    await settle()
    const whitespaceHidden = !diffShadow.querySelector("[data-whitespace]") && diffShadow.querySelector("[data-line]")!.textContent == originalLine
    const newlineNotice = !document.querySelector(".diff-line.notice") && !!diffShadow.querySelector("[data-no-newline]")
    const lightBackground = getComputedStyle(element(".diff-inspector")).backgroundColor
    element("button[aria-label='Switch to dark appearance']").click()
    await settle()
    const darkBackground = getComputedStyle(element(".diff-inspector")).backgroundColor
    const darkGraphColors = graphColors()
    const branchGraphThemeColors = darkGraphColors[0] == darkGraphColors[1] && darkGraphColors[0] != darkGraphColors[2]
        && darkGraphColors.every((color, index) => color != "none" && color != lightGraphColors[index])
    const linkedAfterRender = [...diffShadow.querySelectorAll<HTMLElement>("[data-code]")].every(pane => pane.scrollLeft == 100)

    const branchTrigger = element(".stack-heading:not(:disabled)")
    const branchPanel = element(`#${CSS.escape(branchTrigger.getAttribute("aria-controls")!)}`)
    const branchExpanded = branchTrigger.getAttribute("aria-expanded") == "true" && !branchPanel.hidden
    element(".commit-heading").click()
    await settle()
    const commitTrigger = element(".commit-heading")
    const commitPanel = element(`#${CSS.escape(commitTrigger.getAttribute("aria-controls")!)}`)
    const commitExpanded = commitTrigger.getAttribute("aria-expanded") == "true" && !commitPanel.hidden
    const commitNodes = [...document.querySelectorAll<HTMLElement>(".commit-heading > span:first-child")]
    const commitLine = getComputedStyle(commitTrigger, "::before")
    const fileLine = getComputedStyle(element(".inspect-commit .change-file"), "::before")
    const commitGraph = commitNodes.length == 2
        && commitNodes.every(node => getComputedStyle(node).borderRadius == "50%")
        && commitLine.width == "2px"
        && fileLine.width == "2px"
        && commitLine.top == "-1px"
        && commitLine.bottom == "-1px"
        && commitLine.left == fileLine.left
        && commitLine.left == `${commitNodes[0].offsetLeft + commitNodes[0].offsetWidth / 2 - 1}px`
        && ![...document.querySelectorAll(".commit-heading")].some(heading => /[▸▾]/u.test(heading.textContent ?? ""))
    scenario.page.lines = [
        { id: 0, kind: "hunk", text: "@@ -1000,1 +1000,1 @@", hunk: 0 },
        { id: 1, kind: "deletion", text: "old\r", oldLine: 1000, hunk: 0 },
        {
            id: 2,
            kind: "addition",
            text: "new",
            newLine: 1000,
            hunk: 0,
        },
    ]
    element(".inspect-commit .change-file button").click()
    await settle()
    const compactDiff = element(".inspect-commit .pierre-diff")
    const commitDiffClear = getComputedStyle(element(".inspect-commit .diff-inspector"), "::before").content == "none"
    const compactSplit = compactDiff.getBoundingClientRect().height < 120
    element("[aria-label='Unified']").click()
    await settle()
    const compactUnified = compactDiff.getBoundingClientRect().height < 150
    const inlineDiff = element(".inspect-commit .change-file").nextElementSibling == element(".inspect-commit .diff-inspector")
    const flatFiles = !document.querySelector(".inspect-commit .file-tree details")
    compactDiff.shadowRoot!.querySelector<HTMLButtonElement>("[aria-label='Select hunk']")!.click()
    await settle()
    const hunkSelected = compactDiff.shadowRoot!.querySelectorAll(".diff-line.selected").length == 2
    const endingToggle = compactDiff.closest(".file-inspection")!.querySelector<HTMLButtonElement>("[aria-label='Show whitespace']")!
    const originalHeights = [...compactDiff.shadowRoot!.querySelectorAll("[data-line]")].map(line => line.getBoundingClientRect().height)
    endingToggle.click()
    await settle()
    const endingMarkers = [...compactDiff.shadowRoot!.querySelectorAll<HTMLElement>("[data-whitespace=line-ending]")]
    const distinctLineEndings = endingMarkers.map(marker => marker.dataset.ending).join(",") == "CRLF,LF"
    const endingsStayOnRow = endingMarkers.every(marker => {
        const row = marker.closest("[data-line]")!.getBoundingClientRect()
        const bounds = marker.getBoundingClientRect()
        return bounds.top >= row.top && bounds.bottom <= row.bottom
    }) && [...compactDiff.shadowRoot!.querySelectorAll("[data-line]")].every((line, index) => line.getBoundingClientRect().height == originalHeights[index])
    compactDiff.closest(".file-inspection")!.querySelector<HTMLButtonElement>("[aria-label='Side by side']")!.click()
    await settle()
    const endingRows = [...compactDiff.shadowRoot!.querySelectorAll("[data-line]")].map(line => line.getBoundingClientRect())
    const endingRowsAligned = endingRows.length == 2 && endingRows[0].top == endingRows[1].top && endingRows.every(row => row.height == 24)
    compactDiff.closest(".file-inspection")!.querySelector<HTMLButtonElement>("[aria-label='Unified']")!.click()
    await settle()
    const commitFiles = [...document.querySelectorAll<HTMLButtonElement>(".inspect-commit .change-file > button")]
    commitFiles[1].click()
    await settle()
    const firstFile = commitFiles[0].closest<HTMLElement>(".file-inspection")!
    const secondFile = commitFiles[1].closest<HTMLElement>(".file-inspection")!
    const adjacentDiffs = !!firstFile.querySelector(".diff-inspector") && !!secondFile.querySelector(".diff-inspector")
        && firstFile.nextElementSibling == secondFile
        && firstFile.querySelector(".diff-inspector")!.getBoundingClientRect().bottom <= secondFile.getBoundingClientRect().top
    const secondViewer = secondFile.querySelector(".pierre-diff")
    commitFiles[0].click()
    await settle()
    const independentDiffs = !firstFile.querySelector(".diff-inspector") && secondViewer != null && secondFile.querySelector(".pierre-diff") == secondViewer
    commitFiles[1].click()
    await settle()
    const largeLines = Array.from(
        { length: 500 },
        (_, id) => ({ id, kind: "addition" as const, text: `line ${id + 1} ${"long content ".repeat(30)}`, newLine: id + 1, hunk: 0 }),
    )
    // Keep the scrolling payload separate from the TypeScript highlighting fixture.
    const readDiff = scenario.api.readFileDiff
    scenario.api.readFileDiff = async (...args) => {
        const result = await readDiff(...args)
        return result.ok && args[2].path == "other.txt" ? { ...result, page: { ...result.page, lines: largeLines } } : result
    }
    commitFiles[1].click()
    await settle()
    const longDiff = secondFile.querySelector<HTMLElement>(".pierre-diff")!
    const outer = longDiff.closest<HTMLElement>(".column-inspection")!
    const noInnerVerticalScroll = getComputedStyle(longDiff).overflow == "visible"
        && [...longDiff.shadowRoot!.querySelectorAll("[data-code]")].every(node => node.scrollHeight == node.clientHeight)
        && longDiff.clientHeight > 480
    outer.scrollTop = longDiff.getBoundingClientRect().bottom - outer.getBoundingClientRect().top + outer.scrollTop - outer.clientHeight
    outer.scrollLeft = outer.scrollWidth
    outer.dispatchEvent(new Event("scroll"))
    await settle()
    const stickyFile = secondFile.querySelector<HTMLElement>(".change-file")!
    const stickyCommit = secondFile.closest(".inspect-commit")!.querySelector<HTMLElement>(".commit-heading")!
    const stickyCommitRow = Math.abs(stickyCommit.getBoundingClientRect().top - outer.getBoundingClientRect().top - outer.clientTop) <= 1
    const stickyCommitOpaque = !getComputedStyle(stickyCommit).backgroundColor.startsWith("rgba")
    const stickyFileRow = Math.abs(stickyFile.getBoundingClientRect().top - stickyCommit.getBoundingClientRect().bottom) <= 1
    const compactFileControls = !secondFile.querySelector(".diff-toolbar")
        && stickyFile.querySelectorAll(".diff-controls button").length == 4
        && [...stickyFile.querySelectorAll(".diff-controls button")].every(button => button.getBoundingClientRect().width <= 22)
    const code = longDiff.shadowRoot!.querySelector<HTMLElement>("[data-code]")!
    code.scrollLeft = code.scrollWidth
    const outerDiffScroll = outer.scrollTop > 0 && outer.scrollLeft == 0 && code.scrollLeft > 0
        && !!longDiff.shadowRoot!.querySelector("[data-line='500']")
        && longDiff.shadowRoot!.querySelectorAll("[data-line]").length <= 80
    secondFile.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!.click()
    await settle()
    const breakout = element(".inspection-breakout")
    const inlineDiffsHiddenAfterBreakout = !document.querySelector(".branch-column .diff-inspector")
    breakout.scrollTop = breakout.scrollHeight
    breakout.scrollLeft = breakout.scrollWidth
    breakout.dispatchEvent(new Event("scroll"))
    await settle()
    const breakoutCode = breakout.querySelector(".pierre-diff")!.shadowRoot!.querySelector<HTMLElement>("[data-code]")!
    breakoutCode.scrollLeft = breakoutCode.scrollWidth
    const breakoutDiffScroll = breakout.scrollTop > 0 && breakout.scrollLeft == 0 && breakoutCode.scrollLeft > 0
        && !!breakout.querySelector(".pierre-diff")!.shadowRoot!.querySelector("[data-line='500']")
    commitFiles[0].click()
    await settle()
    const breakoutSwitchedTo = element(".inspection-breakout .diff-inspector").getAttribute("aria-label")
    const breakoutSwitched = breakoutSwitchedTo == "Diff for src/example.ts" && !document.querySelector(".branch-column .diff-inspector")
        && breakout.querySelector(".pierre-diff")!.shadowRoot!.querySelectorAll("[data-line]").length == 2
    element("[aria-label='Close diff column']").click()
    await settle()
    outer.scrollTop = 0
    outer.scrollLeft = 0
    commitTrigger.focus()
    press(commitTrigger, "ArrowDown")
    const accordionKeyboard = document.activeElement == document.querySelectorAll(".commit-heading")[1]
    commitTrigger.click()
    await settle()
    const commitCollapsed = commitTrigger.getAttribute("aria-expanded") == "false" && commitPanel.hidden
        && !document.querySelector(".inspect-commit .diff-inspector")

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
    const graphScrollDrift = await checkBranchGraphScroll()
    return {
        graphScrollDrift,
        compactSplit,
        balancedMetadata,
        compactUnified,
        inlineDiff,
        flatFiles,
        hunkSelected,
        distinctLineEndings,
        endingsStayOnRow,
        endingRowsAligned,
        adjacentDiffs,
        independentDiffs,
        noInnerVerticalScroll,
        outerDiffScroll,
        breakoutDiffScroll,
        inlineDiffsHiddenAfterBreakout,
        breakoutSwitched,
        breakoutSwitchedTo,
        newlineNotice,
        stickyFileRow,
        stickyCommitRow,
        stickyCommitOpaque,
        compactFileControls,
        literalSelection,
        alignedSplit,
        linkedFromLeft,
        linkedFromRight,
        unequalWidthsStable,
        linkedAfterRender,
        diffLineHeight,
        syntaxHighlighted,
        intraLineHighlight,
        whitespaceDefaultOff,
        whitespaceVisible,
        lineEndingsVisible,
        whitespaceHidden,
        lightBackground,
        darkBackground,
        branchExpanded,
        commitExpanded,
        commitGraph,
        branchGraphConnected,
        branchGraphColors,
        branchGraphThemeColors,
        commitDiffClear,
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
