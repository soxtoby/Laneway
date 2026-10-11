import { createRoot } from "remix/ui"
import { LanewayApp } from "../../src/renderer/src/app"
import { inspectionScenario } from "../renderer-fixtures"
import { checkBranchGraphScroll } from "./branch-graph-scroll"

Object.assign(window, {
    rendererChecks: checkRenderer().catch(error => Promise.reject(new Error(error instanceof Error ? error.stack ?? error.message : String(error)))),
})

async function checkRenderer() {
    let violations: string[] = []
    document.addEventListener("securitypolicyviolation", event => violations.push(`${event.violatedDirective}: ${event.blockedURI}`))
    let scenario = inspectionScenario()
    // A second remote makes the settings offer a remote choice.
    scenario.graph.availableRemotes = ["origin", "upstream"]
    let worktreeExecutions = 0
    scenario.api.previewWorktree = async (_id, request) => ({
        ok: true,
        preview: {
            request,
            worktrees: [],
            affected: ["D:/project.worktrees/feature"],
            destination: "D:/project.worktrees/feature",
            ignored: [],
            ignoredCount: 0,
            dirty: false,
            uniqueCommits: false,
            populatedSubmodules: false,
            token: "current",
        },
    })
    scenario.api.executeWorktree = async () => {
        worktreeExecutions++
        return { ok: true }
    }
    scenario.api.readFileHistory = async (_repository, _requestId, request) => ({
        ok: true,
        page: request.related
            ? { entries: [], related: [{ path: "other.txt", objectId: "2".repeat(40), evidence: "shared lines", score: 2 }] }
            : {
                tip: "2".repeat(40),
                entries: Array.from({ length: 30 }, (_, index) => ({
                    objectId: index == 0 ? "2".repeat(40) : (index + 10).toString(16).padStart(40, "0"),
                    parentIds: ["1".repeat(40)],
                    followedParent: "1".repeat(40),
                    subject: "Trace file changes with a long commit subject that must stay on one line ".repeat(3),
                    authorName: "Test",
                    authorEmail: "test@example.test",
                    authoredAt: 1,
                    path: request.path,
                    status: "M",
                    composable: true,
                })),
            },
    })
    let holdComparison = false
    let finishComparison: (() => void) | undefined
    let finishComparisonPatch: (() => void) | undefined
    let readPatch = scenario.api.readFileDiff
    scenario.api.readFileDiff = async (...args) => {
        if (holdComparison && args[2].source.kind == "comparison")
            await new Promise<void>(resolve => finishComparisonPatch = resolve)
        return readPatch(...args)
    }
    let readChanges = scenario.api.readChanges
    scenario.api.readChanges = async (...args) => {
        if (holdComparison && args[2].source.kind == "branches")
            await new Promise<void>(resolve => finishComparison = resolve)
        let result = await readChanges(...args)
        if (result.ok && args[2].source.kind == "branches")
            result.inventory.source = { kind: "comparison", fromObjectId: "2".repeat(40), toObjectId: "1".repeat(40) }
        return result
    }
    let readGraph = scenario.api.readBranchGraph
    scenario.api.readBranchGraph = async (...args) => {
        let result = await readGraph(...args)
        if (result.ok) {
            let [main, feature] = result.graph.branches
            if (holdComparison)
                main.tip = "a".repeat(40)
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
    let readHistory = scenario.api.readBranchHistory
    let commitSubject = "Preserve uncommitted worktree changes when switching between branches in separate workspace columns"
    let commitBody = "Keep each branch's changes attached to its original worktree.\n\nRestore those changes when returning to the branch."
    scenario.api.readBranchHistory = async (...args) => {
        let result = await readHistory(...args)
        if (result.ok) {
            result.page.commits[0].subject = commitSubject
            result.page.commits[0].body = commitBody
            result.page.commits.push({ ...result.page.commits[0], objectId: "4".repeat(40), subject: "Another change", body: undefined })
        }
        return result
    }
    scenario.page.lines.push({ id: 3, kind: "notice", text: "\\ No newline at end of file", hunk: 0 })
    let root = createRoot(document.querySelector<HTMLElement>("#app")!)
    root.render(<LanewayApp api={scenario.api} />)
    await settle()
    await new Promise<void>(resolve => element<HTMLButtonElement>('[aria-label="Filter files"]').addEventListener("click", () => resolve(), { once: true }))
    await settle()
    if (document.activeElement != element('[aria-label="Filter changed files"]'))
        throw new Error("Opening column filter did not focus its textbox")
    element<HTMLButtonElement>('[aria-label="Close file filter"]').click()
    await settle()
    // The rail starts collapsed as an icon strip.
    let rail = element(".repository-rail").getBoundingClientRect()
    let railToggle = element('[aria-label="Expand repository sidebar"]').getBoundingClientRect()
    if (rail.bottom - railToggle.bottom > 16)
        throw new Error("Repository sidebar toggle is not at the bottom")
    let repositoryNav = element('nav[aria-label="Open repositories"]')
    let repositoryButton = element(".repository-item")
    if ([...document.querySelectorAll(".repository-item > span:nth-child(2)")].some(node => getComputedStyle(node).display != "none"))
        throw new Error("Collapsed repository labels are still visible")
    let repoRect = repositoryButton.getBoundingClientRect()
    let navRect = repositoryNav.getBoundingClientRect()
    let iconRect = element(".repository-item > span:first-child").getBoundingClientRect()
    let addRect = element(".rail-add").getBoundingClientRect()
    if (repoRect.right > navRect.right || repositoryNav.scrollWidth > repositoryNav.clientWidth)
        throw new Error("Collapsed repository buttons overflow the sidebar")
    if (
        Math.abs((iconRect.left + iconRect.right) - (repoRect.left + repoRect.right)) > 2
        || Math.abs((addRect.left + addRect.right) - (repoRect.left + repoRect.right)) > 2
    ) {
        throw new Error(
            `Collapsed alignment: ${
                JSON.stringify({
                    repo: repoRect.toJSON(),
                    icon: iconRect.toJSON(),
                    add: addRect.toJSON(),
                    padding: getComputedStyle(repositoryButton).padding,
                    columns: getComputedStyle(repositoryButton).gridTemplateColumns,
                })
            }`,
        )
    }
    repositoryButton.focus()
    if (parseFloat(getComputedStyle(repositoryButton).outlineOffset) > -2)
        throw new Error("Repository focus outline is clipped by the navigation viewport")
    element<HTMLButtonElement>('[aria-label="Expand repository sidebar"]').click()
    await settle()
    let expandedFooter = element(".rail-footer")
    let expandedToggle = element('[aria-label="Collapse repository sidebar"]')
    let footerStyle = getComputedStyle(expandedFooter)
    let footerContentWidth = expandedFooter.clientWidth - parseFloat(footerStyle.paddingLeft) - parseFloat(footerStyle.paddingRight)
    if (Math.abs(expandedToggle.getBoundingClientRect().width - footerContentWidth) > 1)
        throw new Error("Expanded repository sidebar toggle is not full width")
    if (
        !element(".rail-add").textContent?.includes("Add repository")
        || Math.abs(element(".rail-add").getBoundingClientRect().width - element(".repository-item").getBoundingClientRect().width) > 1
    ) {
        throw new Error("Expanded Add repository must be a labeled full-width button")
    }

    // The Branch Graph starts hidden.
    element<HTMLButtonElement>("[aria-label='Show Branch Graph']").click()
    await settle()
    let graphRows = [...document.querySelectorAll<HTMLElement>(".graph-row")]
    let branchGraphConnected = graphRows.length == 3 && graphRows.every((row, index) => {
        let rail = row.querySelector("svg")!
        return rail.getBoundingClientRect().top == row.getBoundingClientRect().top
            && rail.getBoundingClientRect().height == 40
            && (index == 0 || graphRows[index - 1].getBoundingClientRect().bottom == row.getBoundingClientRect().top)
            && rail.querySelectorAll("path").length > 0
    }) && graphRows[0].querySelector("circle")!.getAttribute("cx") != graphRows[2].querySelector("circle")!.getAttribute("cx")
    let graphColors = () => [...document.querySelectorAll(".graph-row circle")].map(node => getComputedStyle(node).stroke)
    let lightGraphColors = graphColors()
    // Branch lines and the Primary rail keep distinct colours; the rail itself starts only where a branch joins it.
    let branchGraphColors = lightGraphColors[0] == lightGraphColors[1] && lightGraphColors[0] != lightGraphColors[2]
        && new Set(graphRows.flatMap(row => [...row.querySelectorAll(".graph-rail-lines path")].map(path => getComputedStyle(path).stroke))).size == 2
    // File rows drag, so pressing one must leave the native drag free to start; the click expands and selects.
    let fileButton = element(".change-file button[aria-expanded]")
    let filePress = new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true, composed: true })
    fileButton.dispatchEvent(filePress)
    await settle()
    let pressLeavesFileCollapsed = !filePress.defaultPrevented && fileButton.getAttribute("aria-expanded") == "false"
    fileButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }))
    fileButton.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true, composed: true }))
    await settle()
    let expandedOnClick = fileButton.getAttribute("aria-expanded") == "true"
    let selectedFile = element<HTMLInputElement>(".change-file input[type=checkbox]")
    let selectPress = new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true, composed: true })
    selectedFile.dispatchEvent(selectPress)
    await settle()
    let pressLeavesFileUnselected = !selectPress.defaultPrevented && !selectedFile.checked
    selectedFile.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }))
    selectedFile.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true, composed: true }))
    await settle()
    let selectedOnClick = selectedFile.checked
    selectedFile.click()
    await settle()
    let diffShadow = element(".pierre-diff").shadowRoot!
    let metadata = element(".diff-summary")
    let metadataStyle = getComputedStyle(metadata)
    let balancedMetadata = metadataStyle.paddingTop == metadataStyle.paddingBottom
        && Math.abs(metadata.getBoundingClientRect().bottom - diffShadow.querySelector("[data-line]")!.getBoundingClientRect().top) <= 1
    let deletion = diffShadow.querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!
    deletion.click()
    await settle()
    let literalSelection = diffShadow.querySelectorAll(".diff-line.selected").length == 1
        && !diffShadow.querySelector(".addition.selected")
    let splitButton = element<HTMLButtonElement>("[aria-label='Side by side']")
    splitButton.click()
    await settle()
    let oldLine = diffShadow.querySelector<HTMLElement>("[data-deletions] [data-line]")!
    let newLine = diffShadow.querySelector<HTMLElement>("[data-additions] [data-line]")!
    let alignedSplit = oldLine.getBoundingClientRect().top == newLine.getBoundingClientRect().top
        && newLine.getBoundingClientRect().left > oldLine.getBoundingClientRect().left
    let diffLineHeight = oldLine.getBoundingClientRect().height
    let leftPane = diffShadow.querySelector<HTMLElement>("[data-deletions]")!
    let rightPane = diffShadow.querySelector<HTMLElement>("[data-additions]")!
    leftPane.scrollLeft = 100
    leftPane.dispatchEvent(new Event("scroll"))
    let linkedFromLeft = leftPane.scrollLeft == 100 && rightPane.scrollLeft == 100
    rightPane.scrollLeft = 200
    rightPane.dispatchEvent(new Event("scroll"))
    let linkedFromRight = leftPane.scrollLeft == 200 && rightPane.scrollLeft == 200
    rightPane.scrollLeft = rightPane.scrollWidth
    rightPane.dispatchEvent(new Event("scroll"))
    let widerOffset = rightPane.scrollLeft
    leftPane.dispatchEvent(new Event("scroll"))
    let unequalWidthsStable = widerOffset > leftPane.scrollLeft && rightPane.scrollLeft == widerOffset
    leftPane.scrollLeft = 100
    leftPane.dispatchEvent(new Event("scroll"))
    // Highlighting completes asynchronously after the initial plain render.
    for (let attempt = 0; attempt < 50 && !diffShadow.querySelector("[data-line] span[style]"); attempt++)
        await new Promise(resolve => setTimeout(resolve, 20))
    let syntaxHighlighted = !!diffShadow.querySelector("[data-line] span[style]")
    let intraLineHighlight = [...diffShadow.querySelectorAll("[data-line] [data-diff-span]")].some(span => {
        let text = span.textContent ?? ""
        return text.length > 0 && text.length < 10 && getComputedStyle(span).backgroundColor != "rgba(0, 0, 0, 0)"
    })
    let whitespaceToggle = element<HTMLButtonElement>("[aria-label='Show whitespace']")
    let whitespaceDefaultOff = whitespaceToggle.getAttribute("aria-pressed") == "false" && !diffShadow.querySelector("[data-whitespace]")
    let originalLine = diffShadow.querySelector("[data-line]")!.textContent
    whitespaceToggle.click()
    await settle()
    let whitespaceVisible = whitespaceToggle.getAttribute("aria-pressed") == "true"
        && !!diffShadow.querySelector("[data-whitespace=space]") && !!diffShadow.querySelector("[data-whitespace=tab]")
        && diffShadow.querySelector("[data-line]")!.textContent == originalLine
        && diffShadow.querySelectorAll(".diff-line.selected").length == 1
    let lineEndingsVisible = !!diffShadow.querySelector("[data-deletions] [data-whitespace=line-ending]")
        && !diffShadow.querySelector("[data-additions] [data-whitespace=line-ending]")
    whitespaceToggle.click()
    await settle()
    let whitespaceHidden = !diffShadow.querySelector("[data-whitespace]") && diffShadow.querySelector("[data-line]")!.textContent == originalLine
    let newlineNotice = !document.querySelector(".diff-line.notice") && !!diffShadow.querySelector("[data-no-newline]")
    let lightBackground = getComputedStyle(element(".diff-inspector")).backgroundColor
    element("button[aria-label='Switch to dark appearance']").click()
    await settle()
    let darkBackground = getComputedStyle(element(".diff-inspector")).backgroundColor
    let darkGraphColors = graphColors()
    let branchGraphThemeColors = darkGraphColors[0] == darkGraphColors[1] && darkGraphColors[0] != darkGraphColors[2]
        && darkGraphColors.every((color, index) => color != "none" && color != lightGraphColors[index])
    let linkedAfterRender = [...diffShadow.querySelectorAll<HTMLElement>("[data-code]")].every(pane => pane.scrollLeft == 100)

    // A card's own edge replaces its last row's bottom rule: that rule sits exactly under the clip.
    let cards = [...document.querySelectorAll<HTMLElement>(".stack-branch, .commit-card:not(.clean)")]
    let singleCardEdge = cards.length >= 2 && cards.every(card => {
        let inner = card.getBoundingClientRect().bottom - parseFloat(getComputedStyle(card).borderBottomWidth)
        let rows = [...card.children].map(child => child.getBoundingClientRect()).filter(rect => rect.height > 0)
        return Math.max(...rows.map(rect => rect.bottom)) - inner == 1
    })
    let branchPanel = element(".stack-branch > div")
    let branchExpanded = !element(".stack-branch").querySelector(".stack-heading") && !branchPanel.hidden
    let collapsedCommit = element(".commit-heading")
    let collapsedHeight = collapsedCommit.parentElement!.getBoundingClientRect().height
    let commitTooltip = collapsedCommit.title == `${commitSubject}\n\n${commitBody}`
        && collapsedCommit.querySelector<HTMLElement>(".commit-subject")!.scrollWidth
            > collapsedCommit.querySelector<HTMLElement>(".commit-subject")!.clientWidth
        && document.querySelectorAll<HTMLElement>(".commit-heading")[1].title == "Another change"
    let indicator = element(".commit-message-indicator")
    let commitBodyIndicator = indicator.getBoundingClientRect().width <= 12 && indicator.getBoundingClientRect().height <= 12
        && !document.querySelectorAll(".commit-heading")[1].querySelector(".commit-message-indicator")
    element(".commit-heading").click()
    await settle()
    let commitTrigger = element(".commit-heading")
    let commitPanel = element(`#${CSS.escape(commitTrigger.getAttribute("aria-controls")!)}`)
    let commitExpanded = commitTrigger.getAttribute("aria-expanded") == "true" && !commitPanel.hidden
    let commitSubjectSpan = commitTrigger.querySelector<HTMLElement>(".commit-subject")!
    let commitMessage = element<HTMLParagraphElement>(".commit-message-body")
    let messageToggle = element(".commit-message-toggle")
    let expandedCommitMessage = commitTrigger.parentElement!.getBoundingClientRect().height > collapsedHeight
        && getComputedStyle(commitSubjectSpan).whiteSpace == "normal"
        && commitSubjectSpan.scrollWidth <= commitSubjectSpan.clientWidth
        && !commitMessage.hidden
        && messageToggle.getAttribute("aria-expanded") == "true"
        && !commitTrigger.querySelector(".commit-message-indicator")
        && commitMessage.textContent == commitBody
        && getComputedStyle(commitMessage).whiteSpace == "pre-wrap"
    messageToggle.click()
    await settle()
    let messagePreview = element(".commit-message-preview")
    let descriptionPreview = commitMessage.hidden && messageToggle.getAttribute("aria-expanded") == "false"
        && getComputedStyle(messagePreview).whiteSpace == "nowrap"
        && getComputedStyle(messagePreview).textOverflow == "ellipsis"
        && messagePreview.scrollWidth > messagePreview.clientWidth
    messageToggle.click()
    await settle()
    let commitDescriptionCollapsible = descriptionPreview && !commitMessage.hidden && messageToggle.getAttribute("aria-expanded") == "true"
        && !document.querySelector(".commit-message-preview")
    let commitNodes = [...document.querySelectorAll<HTMLElement>(".commit-heading > span:first-child")]
    let commitLine = getComputedStyle(commitTrigger.parentElement!, "::before")
    let fileLine = getComputedStyle(element(".inspect-commit .change-file"), "::before")
    let commitGraph = commitNodes.length == 2
        && commitNodes.every(node => getComputedStyle(node).borderRadius == "50%")
        && commitLine.width == "2px"
        && fileLine.width == "2px"
        && commitLine.top == "-1px"
        && commitLine.bottom == "-1px"
        && commitLine.left == fileLine.left
        && commitLine.left == `${commitNodes[0].offsetLeft + commitNodes[0].offsetWidth / 2 - 1}px`
        && ![...document.querySelectorAll(".commit-heading")].some(heading => /[▸▾]/u.test(heading.textContent ?? ""))
    // A drag over a commit heading lands by position: its top edge inserts above the commit, the middle lands on it.
    // Seams stay collapsed throughout, so starting a drag never moves the rows.
    // The row, not its grip, is the registered draggable and the target of a native dragstart.
    let grip = element(".change-file .composition-handle").closest<HTMLElement>(".change-file")!
    let heading = commitTrigger.parentElement!
    let headingRect = heading.getBoundingClientRect()
    let seams = [...document.querySelectorAll<HTMLElement>(".composition-seam")]
    let seamHeights = () => seams.map(seam => seam.getBoundingClientRect().height)
    let seamsCollapsedBefore = seamHeights().every(height => height == 0)
    let dragTransfer = new DataTransfer()
    let dragAt = (clientY: number) => ({
        bubbles: true,
        cancelable: true,
        dataTransfer: dragTransfer,
        clientX: headingRect.left + headingRect.width / 2,
        clientY,
    })
    let frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    grip.dispatchEvent(new DragEvent("dragstart", dragAt(headingRect.top + 1)))
    await frames()
    heading.dispatchEvent(new DragEvent("dragenter", dragAt(headingRect.top + 1)))
    heading.dispatchEvent(new DragEvent("dragover", dragAt(headingRect.top + 1)))
    await frames()
    await settle()
    let edgeDropAbove = heading.classList.contains("composition-over-above") && !heading.classList.contains("composition-over")
    let dragKeepsLayout = seamsCollapsedBefore && seamHeights().every(height => height == 0)
        && Math.abs(heading.getBoundingClientRect().top - headingRect.top) < 1
    heading.dispatchEvent(new DragEvent("dragover", dragAt(headingRect.top + headingRect.height / 2)))
    await frames()
    await settle()
    let edgeDropCentre = heading.classList.contains("composition-over") && !heading.classList.contains("composition-over-above")
    grip.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dragTransfer }))
    await frames()
    await settle()
    let dragCleared = !document.querySelector(".composition-over, .composition-over-above, .composition-over-below")
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
    element(".inspect-commit .change-file button[aria-expanded]").click()
    await settle()
    let compactDiff = element(".inspect-commit .pierre-diff")
    let commitDiffClear = getComputedStyle(element(".inspect-commit .diff-inspector"), "::before").content == "none"
    let compactSplit = compactDiff.getBoundingClientRect().height < 120
    element("[aria-label='Unified']").click()
    await settle()
    let compactUnified = compactDiff.getBoundingClientRect().height < 150
    let inlineDiff = element(".inspect-commit .change-file").nextElementSibling == element(".inspect-commit .diff-inspector")
    let flatFiles = !document.querySelector(".inspect-commit .file-tree details")
    compactDiff.shadowRoot!.querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1000']")!.click()
    await settle()
    let lineSelected = compactDiff.shadowRoot!.querySelectorAll(".diff-line.selected").length == 1
    let contextExpansion = compactDiff.shadowRoot!.querySelector<HTMLButtonElement>("[aria-label='Show 999 hidden lines']")!
    let contextExpansionVisible = contextExpansion.getBoundingClientRect().width > 0
        && contextExpansion.querySelector<SVGPathElement>("path")!.getBBox().height > 0
    let endingToggle = compactDiff.closest(".file-inspection")!.querySelector<HTMLButtonElement>("[aria-label='Show whitespace']")!
    let originalHeights = [...compactDiff.shadowRoot!.querySelectorAll("[data-line]")].map(line => line.getBoundingClientRect().height)
    endingToggle.click()
    await settle()
    let endingMarkers = [...compactDiff.shadowRoot!.querySelectorAll<HTMLElement>("[data-whitespace=line-ending]")]
    let distinctLineEndings = endingMarkers.map(marker => marker.dataset.ending).join(",") == "CRLF,LF"
    let endingsStayOnRow = endingMarkers.every(marker => {
        let row = marker.closest("[data-line]")!.getBoundingClientRect()
        let bounds = marker.getBoundingClientRect()
        return bounds.top >= row.top && bounds.bottom <= row.bottom
    }) && [...compactDiff.shadowRoot!.querySelectorAll("[data-line]")].every((line, index) => line.getBoundingClientRect().height == originalHeights[index])
    compactDiff.closest(".file-inspection")!.querySelector<HTMLButtonElement>("[aria-label='Side by side']")!.click()
    await settle()
    let endingRows = [...compactDiff.shadowRoot!.querySelectorAll("[data-line]")].map(line => line.getBoundingClientRect())
    let endingRowsAligned = endingRows.length == 2 && endingRows[0].top == endingRows[1].top && endingRows.every(row => row.height == 24)
    compactDiff.closest(".file-inspection")!.querySelector<HTMLButtonElement>("[aria-label='Unified']")!.click()
    await settle()
    let largeLines = Array.from(
        { length: 500 },
        (_, id) => ({ id, kind: "addition" as const, text: `line ${id + 1} ${"long content ".repeat(30)}`, newLine: id + 1, hunk: 0 }),
    )
    // Establish committed content before its first read; reopening reuses the snapshot.
    let readDiff = scenario.api.readFileDiff
    scenario.api.readFileDiff = async (...args) => {
        let result = await readDiff(...args)
        return result.ok && args[2].path == "other.txt" ? { ...result, page: { ...result.page, lines: largeLines } } : result
    }
    let commitFiles = [...document.querySelectorAll<HTMLButtonElement>(".inspect-commit .change-file > button:not(.composition-handle)")]
    commitFiles[1].click()
    await settle()
    let firstFile = commitFiles[0].closest<HTMLElement>(".file-inspection")!
    let secondFile = commitFiles[1].closest<HTMLElement>(".file-inspection")!
    let adjacentDiffs = !!firstFile.querySelector(".diff-inspector") && !!secondFile.querySelector(".diff-inspector")
        && firstFile.nextElementSibling == secondFile
        && firstFile.querySelector(".diff-inspector")!.getBoundingClientRect().bottom <= secondFile.getBoundingClientRect().top
    let secondViewer = secondFile.querySelector(".pierre-diff")
    commitFiles[0].click()
    await settle()
    let independentDiffs = !firstFile.querySelector(".diff-inspector") && secondViewer != null && secondFile.querySelector(".pierre-diff") == secondViewer
    commitFiles[1].click()
    await settle()
    commitFiles[1].click()
    await settle()
    let longDiff = secondFile.querySelector<HTMLElement>(".pierre-diff")!
    let outer = longDiff.closest<HTMLElement>(".column-inspection")!
    let noInnerVerticalScroll = getComputedStyle(longDiff).overflow == "visible"
        && [...longDiff.shadowRoot!.querySelectorAll("[data-code]")].every(node => node.scrollHeight == node.clientHeight)
        && longDiff.clientHeight > 480
    outer.scrollTop = longDiff.getBoundingClientRect().bottom - outer.getBoundingClientRect().top + outer.scrollTop - outer.clientHeight
    outer.scrollLeft = outer.scrollWidth
    outer.dispatchEvent(new Event("scroll"))
    await settle()
    let stickyFile = secondFile.querySelector<HTMLElement>(".change-file")!
    let stickyCommit = secondFile.closest(".inspect-commit")!.querySelector<HTMLElement>(".commit-heading")!
    let stickyCommitRow = Math.abs(stickyCommit.getBoundingClientRect().top - outer.getBoundingClientRect().top - outer.clientTop) <= 1
    let stickyCommitOpaque = !getComputedStyle(stickyCommit.parentElement!).backgroundColor.startsWith("rgba")
    let stickyFileRow = Math.abs(stickyFile.getBoundingClientRect().top - stickyCommit.getBoundingClientRect().bottom) <= 1
    let compactFileControls = !secondFile.querySelector(".diff-toolbar")
        && stickyFile.querySelectorAll(".diff-controls button").length == 4
        && [...stickyFile.querySelectorAll(".diff-controls button")].every(button => button.getBoundingClientRect().width <= 22)
    let code = longDiff.shadowRoot!.querySelector<HTMLElement>("[data-code]")!
    code.scrollLeft = code.scrollWidth
    let outerDiffScroll = outer.scrollTop > 0 && outer.scrollLeft == 0 && code.scrollLeft > 0
        && !!longDiff.shadowRoot!.querySelector("[data-line='500']")
        && longDiff.shadowRoot!.querySelectorAll("[data-line]").length <= 80
    // Midway through the long diff its horizontal scrollbar stays pinned to the visible bottom and drives the panes.
    let scrolledToEnd = outer.scrollTop
    outer.scrollTop -= 300
    outer.dispatchEvent(new Event("scroll"))
    await settle()
    let diffScrollbar = longDiff.parentElement!.querySelector<HTMLElement>(".diff-scrollbar")!
    let visibleBottom = outer.getBoundingClientRect().top + outer.clientTop + outer.clientHeight
    let pinnedCode = longDiff.shadowRoot!.querySelector<HTMLElement>("[data-code]")!
    diffScrollbar.scrollLeft = 40
    diffScrollbar.dispatchEvent(new Event("scroll"))
    let stickyDiffScrollbar = !diffScrollbar.hidden && diffScrollbar.offsetHeight - diffScrollbar.clientHeight >= 8
        && Math.abs(diffScrollbar.getBoundingClientRect().bottom - visibleBottom) <= 1
        && longDiff.getBoundingClientRect().bottom > visibleBottom
        && pinnedCode.scrollLeft == 40
        && pinnedCode.offsetHeight == pinnedCode.clientHeight
    outer.scrollTop = scrolledToEnd
    await settle()
    secondFile.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!.click()
    await settle()
    let breakout = element(".inspection-breakout")
    // The diff column joins its source column's card across a seam that still resizes the column.
    let breakoutSeam = breakout.previousElementSibling as HTMLElement
    let breakoutSource = breakoutSeam.previousElementSibling as HTMLElement
    let auxiliarySourceVisible = !!breakout.querySelector(".auxiliary-source")
        && breakoutSource.classList.contains("branch-column")
        && getComputedStyle(breakoutSource).borderTopRightRadius == "0px" && getComputedStyle(breakout).borderTopLeftRadius == "0px"
        && breakoutSeam.matches(".column-divider.attached") && getComputedStyle(breakoutSeam).cursor == "col-resize"
        && breakoutSeam.getBoundingClientRect().width == 6
        && breakout.getBoundingClientRect().left == breakoutSeam.getBoundingClientRect().right
        && breakout.querySelector("header")!.getBoundingClientRect().height == breakoutSource.querySelector("header")!.getBoundingClientRect().height
        && document.activeElement == breakout
    // Header controls stay clear of the column's overlay scrollbar.
    let breakoutScrollbarClear = [element("[aria-label='Close diff column']"), element(".inspection-breakout .diff-toolbar button:last-of-type")]
        .every(control => breakout.getBoundingClientRect().right - control.getBoundingClientRect().right >= 12)
    let inlineDiffsHiddenAfterBreakout = !document.querySelector(".branch-column .diff-inspector")
    // The diff column holds the whole commit and opens scrolled to the broken-out file, its toolbar right under the header.
    let breakoutFile = (path: string) => breakout.querySelector<HTMLElement>(`[data-diff-path='${path}']`)!
    let breakoutHeaderBottom = () => breakout.querySelector("header")!.getBoundingClientRect().bottom
    let breakoutWholeCommit =
        [...breakout.querySelectorAll<HTMLElement>("[data-diff-path]")].map(node => node.dataset.diffPath).join(",") == "src/example.ts,other.txt"
    let breakoutOpenedAtFile = breakout.scrollTop > 0
        && Math.abs(breakoutFile("other.txt").querySelector(".diff-toolbar")!.getBoundingClientRect().top - breakoutHeaderBottom()) <= 1
    breakout.scrollTop = breakout.scrollHeight
    breakout.scrollLeft = breakout.scrollWidth
    breakout.dispatchEvent(new Event("scroll"))
    await settle()
    let breakoutCode = breakoutFile("other.txt").querySelector(".pierre-diff")!.shadowRoot!.querySelector<HTMLElement>("[data-code]")!
    breakoutCode.scrollLeft = breakoutCode.scrollWidth
    let breakoutDiffScroll = breakout.scrollTop > 0 && breakout.scrollLeft == 0 && breakoutCode.scrollLeft > 0
        && !!breakoutFile("other.txt").querySelector(".pierre-diff")!.shadowRoot!.querySelector("[data-line='500']")
    // Scrolled down, the header stays at the top with the diff's toolbar right under it.
    let breakoutHeader = breakout.querySelector("header")!.getBoundingClientRect()
    let breakoutStickyTop = breakout.scrollTop > 0 && breakoutHeader.top == breakout.getBoundingClientRect().top
        && breakoutFile("other.txt").querySelector(".diff-toolbar")!.getBoundingClientRect().top == breakoutHeader.bottom
    // Choosing another file in the source column scrolls the diff column to it rather than replacing the column.
    commitFiles[0].click()
    await settle()
    let breakoutScrolledToFile = breakoutWholeCommit && !document.querySelector(".branch-column .diff-inspector")
        && Math.abs(breakoutFile("src/example.ts").querySelector(".diff-toolbar")!.getBoundingClientRect().top - breakoutHeaderBottom()) <= 1
        && breakoutFile("src/example.ts").querySelector(".pierre-diff")!.shadowRoot!.querySelectorAll("[data-line]").length == 2
    element(".inspection-breakout [aria-label='Collapse all']").click()
    await settle()
    let breakoutCollapsed = !breakout.querySelector(".pierre-diff")
        && [...breakout.querySelectorAll<HTMLElement>("[data-diff-path]")].every(file => file.getBoundingClientRect().height < 50)
        && breakout.querySelectorAll(".diff-toolbar [aria-expanded='false']").length == 2
    commitFiles[1].click()
    await settle()
    let breakoutNavigationExpands = breakout.querySelectorAll(".pierre-diff").length == 1
        && !!breakoutFile("other.txt").querySelector("[aria-expanded='true']")
    element(".inspection-breakout [aria-label='Expand all']").click()
    await settle()
    let breakoutExpanded = breakout.querySelectorAll(".pierre-diff").length == 2
        && breakout.querySelectorAll(".diff-toolbar [aria-expanded='true']").length == 2
    // A maximized column keeps its own width beside its diff column, which takes the rest; resizing moves the split.
    let sourceWidth = breakoutSource.getBoundingClientRect().width
    breakoutSource.querySelector<HTMLButtonElement>("[aria-label='Maximize column']")!.click()
    await settle()
    let splitColumns = element(".branch-columns")
    let splitDiff = element(".inspection-breakout")
    let splitEnd = splitColumns.getBoundingClientRect().right - parseFloat(getComputedStyle(splitColumns).paddingRight)
    let splitFits = () => splitColumns.scrollWidth <= splitColumns.clientWidth && Math.abs(splitDiff.getBoundingClientRect().right - splitEnd) <= 1
    let splitAtRest = breakoutSource.getBoundingClientRect().width == sourceWidth && splitFits()
    let splitDivider = element<HTMLElement>(`[data-column-id="${breakoutSource.dataset.columnId}"] + .column-divider`)
    press(splitDivider, "End")
    await settle()
    let splitCapped = breakoutSource.getBoundingClientRect().width > sourceWidth && splitFits()
        && splitDiff.getBoundingClientRect().width >= 310
    splitDivider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await settle()
    let maximizedSplit = splitAtRest && splitCapped && breakoutSource.getBoundingClientRect().width == 380 && splitFits()
    element<HTMLButtonElement>("[aria-label='Restore columns']").click()
    await settle()
    element("[aria-label='Close diff column']").click()
    await settle()
    outer.scrollTop = 0
    outer.scrollLeft = 0
    commitTrigger.focus()
    press(commitTrigger, "ArrowDown")
    let accordionKeyboard = document.activeElement == document.querySelectorAll(".commit-heading")[1]
    commitTrigger.click()
    await settle()
    let commitCollapsed = commitTrigger.getAttribute("aria-expanded") == "false" && commitPanel.hidden
        && !document.querySelector(".inspect-commit .diff-inspector")

    element("button[aria-label='Branch Graph settings']").click()
    await settle()
    let settingsBounds = element(".graph-settings").getBoundingClientRect()
    let settingsButtonBounds = element("button[aria-label='Branch Graph settings']").getBoundingClientRect()
    let graphSettingsAnchored = settingsBounds.left <= settingsButtonBounds.left
        && settingsBounds.right >= settingsButtonBounds.right
        && settingsBounds.top >= settingsButtonBounds.bottom
        && settingsBounds.top - settingsButtonBounds.bottom <= 16
    let radio = element<HTMLInputElement>("input[type='radio']")
    let radioChecked = radio.checked && radio.getBoundingClientRect().width > 0
    let radioBackground = getComputedStyle(radio).backgroundColor

    element(".lens-button").focus()
    element(".lens-button").click()
    await settle()
    let search = element<HTMLInputElement>(".command-lens input")
    let modal = element<HTMLDialogElement>("dialog.lens-backdrop").matches(":modal")
    search.value = "e"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    let firstActive = search.getAttribute("aria-activedescendant")
    press(search, "ArrowDown")
    await settle()
    let secondActive = search.getAttribute("aria-activedescendant")
    let navigated = firstActive != secondActive && !!secondActive && element(`#${CSS.escape(secondActive)}`).getAttribute("data-highlighted") == "true"
    let searchKeptFocus = document.activeElement == search
    search.value = "not-a-repository"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    let emptyCleared = !search.hasAttribute("aria-activedescendant") && search.getAttribute("aria-expanded") == "false"
    press(search, "Escape")
    await settle()
    let restoredFocus = document.activeElement == element(".lens-button")
    element(".lens-button").click()
    await settle()
    let reopenedSearch = element<HTMLInputElement>(".command-lens input")
    reopenedSearch.value = "feature/laneway"
    reopenedSearch.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    let columnCount = document.querySelectorAll(".branch-column").length
    press(reopenedSearch, "Enter")
    await settle()
    let activatedBranch = !document.querySelector(".command-lens")
        && element(".graph-row.selected").dataset.nodeId == "branch:refs/heads/feature/laneway"
        && document.querySelectorAll(".branch-column").length == columnCount
    let columnBeforeCollapse = element(".branch-column").getBoundingClientRect()
    let collapseButton = element(".branch-column [title='Collapse column']")
    let collapseButtonLeft = collapseButton.getBoundingClientRect().left
    let columnCollapseStillAtLeft = collapseButtonLeft == columnBeforeCollapse.left
    collapseButton.click()
    await settle()
    let collapsedBounds = element(".branch-column").getBoundingClientRect()
    let expandButtonLeft = element(".expand-column").getBoundingClientRect().left
    let collapsedColumnCompact = collapsedBounds.width == 52 && collapsedBounds.left == columnBeforeCollapse.left
    let columnToggleStable = collapseButtonLeft == expandButtonLeft
    element(".expand-column").click()
    await settle()
    let expandedWidthRestored = element(".branch-column").getBoundingClientRect().width == columnBeforeCollapse.width
    let hideGraphButton = element("[aria-label='Hide Branch Graph']")
    let hideGraphButtonCompact = hideGraphButton.getBoundingClientRect().width < 40
    let hideGraphButtonInRail = hideGraphButton.closest(".repository-rail") != null
    let branchToggleHasIcon = hideGraphButton.querySelector("svg") != null
    hideGraphButton.click()
    await settle()
    let showGraphButton = element("[aria-label='Show Branch Graph']")
    let showGraphBounds = showGraphButton.getBoundingClientRect()
    let showGraphButtonCompact = showGraphBounds.width < 40
    let graphToggleStaysInRail = hideGraphButtonInRail && showGraphButton.closest(".repository-rail") != null
        && showGraphButton == hideGraphButton
    let graphDesk = element(".graph-desk")
    let graphFullyHidden = element(".graph-sidebar").getBoundingClientRect().width == 0
        && element(".branch-columns").getBoundingClientRect().left
            == graphDesk.getBoundingClientRect().left + parseFloat(getComputedStyle(graphDesk).paddingLeft)
    // Without the sidebar, columns scroll right up to the repository rail.
    let columnsMeetRail = element(".branch-columns").getBoundingClientRect().left == element(".repository-rail").getBoundingClientRect().right
    showGraphButton.click()
    await settle()
    let graphRestored = element(".graph-sidebar").getBoundingClientRect().width > 0
    // Overflowing columns scroll horizontally on a scrollbar beneath them, not one overlaying their bottom edge.
    let columns = element(".branch-columns")
    let overflowSpacer = columns.appendChild(document.createElement("div"))
    overflowSpacer.style.flex = `0 0 ${columns.clientWidth}px`
    let columnsViewportBottom = columns.getBoundingClientRect().top + columns.clientTop + columns.clientHeight
    let columnScrollbarBelow = columns.scrollWidth > columns.clientWidth
        && columns.offsetHeight - columns.clientHeight >= 8
        && element(".branch-column").getBoundingClientRect().bottom <= columnsViewportBottom
    // Columns start a gutter clear of the sidebar, but scroll beneath its edge and out to the window's edge.
    let sidebarBounds = element(".graph-sidebar").getBoundingClientRect()
    let columnsRestClear = element(".branch-column").getBoundingClientRect().left - sidebarBounds.right == 6
    columns.scrollLeft = 100
    let scrolledColumnHit = document.elementFromPoint(sidebarBounds.right + 1, sidebarBounds.top + 60)
    let sidebarHit = document.elementFromPoint(sidebarBounds.right - 2, sidebarBounds.top + 60)
    let columnsReachEdges = columnsRestClear
        && scrolledColumnHit?.closest(".branch-column") != null
        && sidebarHit?.closest(".graph-sidebar") != null
        && columns.getBoundingClientRect().right == document.documentElement.clientWidth
    columns.scrollLeft = 0
    overflowSpacer.remove()
    element("[data-node-id='branch:refs/heads/feature/laneway']").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 120 }),
    )
    await settle()
    let menuBounds = element("dialog[aria-label='Branch actions']").getBoundingClientRect()
    let contextMenuCompact = menuBounds.width < 180
        && menuBounds.height <= document.querySelectorAll('[aria-label="Branch actions"] [role="menuitem"]').length * 34 + 16
    element("[role='menuitem']").click()
    await settle()
    let comparisonSearch = element<HTMLInputElement>("[aria-label='Command Lens search']")
    comparisonSearch.value = "main"
    comparisonSearch.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    element(".lens-results button").click()
    await settle()
    let comparison = element(".branch-comparison")
    let comparisonContextMenu = document.activeElement == comparison && comparison.textContent!.includes("feature/laneway → main")
        && !comparison.querySelector(".comparison-context") && comparison.previousElementSibling?.previousElementSibling?.classList.contains("branch-column")
    let comparisonLazy = !comparison.querySelector(".pierre-diff")
    let comparisonRow = element(".branch-comparison .change-file")
    let comparisonSharedRows = comparisonRow.getBoundingClientRect().height <= 31
        && !!comparisonRow.querySelector(".file-status svg")
        && getComputedStyle(element(".branch-comparison .file-folder")).textOverflow == "ellipsis"
    element(".branch-comparison .change-file button[aria-expanded]").click()
    await settle()
    let comparisonPatch = !!comparison.querySelector(".pierre-diff")?.shadowRoot?.querySelector("[data-line]")
    let comparisonGeometry = comparison.getBoundingClientRect().width >= 620 && comparison.scrollWidth == comparison.clientWidth
    let rowTop = comparisonRow.getBoundingClientRect().top
    let patchTop = element(".comparison-patch").getBoundingClientRect().top
    holdComparison = true
    window.dispatchEvent(new Event("focus"))
    await settle()
    let refreshStable = () =>
        comparisonRow.getBoundingClientRect().top == rowTop
        && element(".comparison-patch").getBoundingClientRect().top == patchTop
        && !comparison.querySelector("[role='status']")
    let comparisonRefreshStable = refreshStable()
    finishComparison!()
    await settle()
    let comparisonPatchRefreshStable = refreshStable()
    holdComparison = false
    finishComparisonPatch!()
    await settle()
    element(".branch-comparison [aria-label='Side by side']").click()
    await settle()
    let comparisonSplit = element(".branch-comparison [aria-label='Side by side']").getAttribute("aria-pressed") == "true"
    element(".branch-comparison [aria-label='Unified']").click()
    element(".branch-comparison [aria-label='Show whitespace']").click()
    await settle()
    let comparisonControls = comparisonSplit
        && element(".branch-comparison [aria-label='Unified']").getAttribute("aria-pressed") == "true"
        && element(".branch-comparison [aria-label='Show whitespace']").getAttribute("aria-pressed") == "true"
    let header = element(".branch-comparison > header")
    let headerTop = header.getBoundingClientRect().top
    comparison.scrollTop = 80
    await settle()
    let comparisonStickyHeader = getComputedStyle(header).position == "sticky" && header.getBoundingClientRect().top == headerTop
    let comparisonHeaderOnlyClose = header.querySelectorAll("button").length == 1
        && header.querySelector("button")?.getAttribute("aria-label") == "Close comparison"
    comparisonRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 500, clientY: 180 }))
    await settle()
    element("[aria-label='File actions'] [role='menuitem']").click()
    await settle()
    let fileHistory = element(".file-history")
    let historyRow = element(".file-history .history-entry .change-file")
    historyRow.querySelector<HTMLButtonElement>("button")!.click()
    await settle()
    let historySubject = element(".file-history .history-subject")
    let historySingleLine = getComputedStyle(historySubject).whiteSpace == "nowrap"
        && historySubject.scrollWidth > historySubject.clientWidth
        && historyRow.getBoundingClientRect().height < 40
    fileHistory.scrollTop = 40
    await settle()
    let historyStickyRow = getComputedStyle(historyRow).position == "sticky"
        && Math.abs(historyRow.getBoundingClientRect().top - element(".file-history > header").getBoundingClientRect().bottom) < 2
    let historyDirectDiff = !!fileHistory.querySelector(".pierre-diff")
        && !!historyRow.querySelector("[aria-label='Show whitespace']")
        && fileHistory.querySelectorAll(".change-file").length == 30
        && !fileHistory.textContent!.includes("Following parent 1")
    let readHistoryPatch = scenario.api.readFileDiff
    let addedCommit = (39).toString(16).padStart(40, "0")
    scenario.api.readFileDiff = async (...args) => {
        let result = await readHistoryPatch(...args)
        return result.ok && args[2].source.kind == "commit" && args[2].source.objectId == addedCommit
            ? {
                ...result,
                page: {
                    ...result.page,
                    lines: [
                        { id: 0, kind: "hunk", text: "@@ -0,0 +1,300 @@", hunk: 0 },
                        ...Array.from(
                            { length: 300 },
                            (_, index) => ({
                                id: index + 1,
                                kind: "addition" as const,
                                text: `const addedLine${index + 1} = ${index + 1};`,
                                newLine: index + 1,
                                hunk: 0,
                            }),
                        ),
                    ],
                },
            }
            : result
    }
    let addedRow = [...fileHistory.querySelectorAll<HTMLElement>(".history-entry")].at(-1)!
    addedRow.querySelector<HTMLButtonElement>(".change-file > button[aria-expanded]")!.click()
    await settle()
    let historyAddedFileScroll = true
    for (let layout of ["Unified", "Side by side"]) {
        addedRow.querySelector<HTMLButtonElement>(`[aria-label='${layout}']`)!.click()
        await settle()
        fileHistory.scrollTop = fileHistory.scrollHeight
        fileHistory.dispatchEvent(new Event("scroll"))
        await settle()
        let addedShadow = addedRow.querySelector(".pierre-diff")!.shadowRoot!
        historyAddedFileScroll &&= addedShadow.textContent!.includes("addedLine300")
            && [...addedShadow.querySelectorAll("[data-code]")].every(pane => pane.querySelectorAll("[data-line]").length <= 80)
        fileHistory.scrollTop = 0
        fileHistory.dispatchEvent(new Event("scroll"))
        await settle()
        historyAddedFileScroll &&= addedShadow.textContent!.includes("addedLine1 =")
            && [...addedShadow.querySelectorAll("[data-code]")].every(pane => {
                let first = pane.querySelector("[data-content] [data-line]")
                return !first || first.getBoundingClientRect().top == pane.getBoundingClientRect().top
            })
    }
    addedRow.querySelector<HTMLButtonElement>(".change-file > button[aria-expanded]")!.click()
    fileHistory.scrollTop = 40
    await settle()
    historyRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 500, clientY: 180 }))
    await settle()
    let complete = [...fileHistory.querySelectorAll("button")].find(button => button.textContent == "Complete commit diff")!
    complete.click()
    await settle()
    let trail = element(".trail-commit")
    let related = [...trail.querySelectorAll("button")].find(button => button.textContent == "Find related files")!
    related.click()
    await settle()
    element(".trail-commit .related-file").click()
    await settle()
    let historyTrail = document.querySelectorAll(".file-history").length == 2
        && historySingleLine && historyStickyRow && historyDirectDiff
        && trail.querySelectorAll(".change-file").length == 2
        && trail.querySelector(".related-file")!.textContent!.includes("shared lines")
        && getComputedStyle(element(".file-history > header")).position == "sticky"
        && getComputedStyle(element(".trail-commit > header")).position == "sticky"
    element(".file-history [aria-label='Close file history']").click()
    await settle()
    let historyTrailClosed = !document.querySelector(".file-history, .trail-commit")
    element("[aria-label='Close comparison']").click()
    await settle()
    let comparisonClosed = !document.querySelector(".branch-comparison")
    ;[...element("[data-node-id='branch:refs/heads/main']").querySelectorAll("button")].find(button => button.textContent == "Open")!.click()
    await settle()
    element(".column-worktree [aria-label='Check out branch']").click()
    await settle()
    let worktreeMenu = element(".column-worktree [role='menu']")
    let createWorktree = [...worktreeMenu.querySelectorAll("button")].find(button => button.textContent == "New worktree")!
    createWorktree.click()
    await settle()
    let worktreeDialog = element<HTMLDialogElement>('dialog[aria-label="Worktree operation"]')
    let dialogBounds = worktreeDialog.getBoundingClientRect()
    let worktreePreview = worktreeDialog.open && worktreeExecutions == 0 && worktreeDialog.textContent!.includes("D:/project.worktrees/feature")
        && dialogBounds.left >= 0 && dialogBounds.right <= window.innerWidth && dialogBounds.top >= 0 && dialogBounds.bottom <= window.innerHeight
    ;[...worktreeDialog.querySelectorAll("button")].find(button => button.textContent == "Cancel")!.click()
    await settle()
    let worktreeCancelled = !document.querySelector('dialog[aria-label="Worktree operation"]') && worktreeExecutions == 0
    // Worktree controls sit in the column header, which stays a single compact row above the inspection.
    let worktreeRow = element(".column-worktree")
    let worktreeColumn = worktreeRow.closest<HTMLElement>(".branch-column")!
    let inspectionBounds = worktreeColumn.querySelector(".column-inspection")!.getBoundingClientRect()
    let rowBounds = worktreeColumn.querySelector("header")!.getBoundingClientRect()
    let worktreeRowCompact = rowBounds.height <= 48 && Math.abs(inspectionBounds.top - rowBounds.bottom) <= 1
    let stylesheets = document.adoptedStyleSheets.length
    root.dispose()
    let graphScrollDrift = await checkBranchGraphScroll()
    let virtualWorktreeCompact = await checkVirtualWorktree()
    let worktreeRecovery = await checkRecoveryColumn()
    return {
        worktreePreview,
        worktreeCancelled,
        worktreeRowCompact,
        virtualWorktreeCompact,
        worktreeRecovery,
        historyTrail,
        historySingleLine,
        historyStickyRow,
        historyDirectDiff,
        historyAddedFileScroll,
        historyTrailClosed,
        comparisonControls,
        comparisonStickyHeader,
        comparisonHeaderOnlyClose,
        contextMenuCompact,
        comparisonSharedRows,
        comparisonRefreshStable,
        comparisonPatchRefreshStable,
        graphScrollDrift,
        comparisonContextMenu,
        comparisonLazy,
        comparisonPatch,
        comparisonGeometry,
        comparisonClosed,
        collapsedColumnCompact,
        columnToggleStable,
        columnCollapseStillAtLeft,
        expandedWidthRestored,
        graphFullyHidden,
        graphRestored,
        columnsMeetRail,
        columnScrollbarBelow,
        columnsReachEdges,
        hideGraphButtonCompact,
        showGraphButtonCompact,
        branchToggleHasIcon,
        graphToggleStaysInRail,
        graphSettingsAnchored,
        compactSplit,
        balancedMetadata,
        compactUnified,
        inlineDiff,
        flatFiles,
        pressLeavesFileCollapsed,
        expandedOnClick,
        pressLeavesFileUnselected,
        selectedOnClick,
        lineSelected,
        contextExpansionVisible,
        distinctLineEndings,
        endingsStayOnRow,
        endingRowsAligned,
        adjacentDiffs,
        independentDiffs,
        noInnerVerticalScroll,
        outerDiffScroll,
        breakoutDiffScroll,
        auxiliarySourceVisible,
        maximizedSplit,
        breakoutScrollbarClear,
        breakoutStickyTop,
        inlineDiffsHiddenAfterBreakout,
        breakoutWholeCommit,
        breakoutOpenedAtFile,
        breakoutScrolledToFile,
        breakoutCollapsed,
        breakoutNavigationExpands,
        breakoutExpanded,
        newlineNotice,
        stickyFileRow,
        edgeDropAbove,
        edgeDropCentre,
        dragKeepsLayout,
        dragCleared,
        stickyCommitRow,
        stickyCommitOpaque,
        compactFileControls,
        literalSelection,
        alignedSplit,
        linkedFromLeft,
        linkedFromRight,
        unequalWidthsStable,
        linkedAfterRender,
        stickyDiffScrollbar,
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
        commitTooltip,
        commitBodyIndicator,
        commitDescriptionCollapsible,
        expandedCommitMessage,
        commitExpanded,
        commitGraph,
        branchGraphConnected,
        branchGraphColors,
        branchGraphThemeColors,
        commitDiffClear,
        commitCollapsed,
        accordionKeyboard,
        radioChecked,
        singleCardEdge,
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

    async function settle() {
        for (let index = 0; index < 8; index++) {
            await new Promise(resolve => setTimeout(resolve, 0))
            root.flush()
        }
    }
    function element<T extends HTMLElement = HTMLElement>(selector: string) {
        let node = document.querySelector<T>(selector)
        if (!node)
            throw new Error(`Missing ${selector}`)
        return node
    }
    function press(node: HTMLElement, key: string) {
        node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    }
}

async function checkVirtualWorktree() {
    let scenario = inspectionScenario()
    let readGraph = scenario.api.readBranchGraph
    scenario.api.readBranchGraph = async (...args) => {
        let result = await readGraph(...args)
        if (result.ok) {
            let branch = result.graph.branches[1]!
            let worktree = branch.checkedOut[0]!
            branch.checkedOut = []
            result.graph.virtualBranches = [{
                kind: "virtual",
                id: "virtual:inspection",
                name: "inspection",
                objectId: branch.tip,
                tooltip: "Detached worktree",
                worktree: { ...worktree, main: false },
            }]
            scenario.api.readBranchGraph = async () => result
        }
        return result
    }
    scenario.api.readChanges = async (_id, _requestId, request) => ({
        ok: true,
        inventory: { source: request.source, files: [], version: "clean", parents: [] },
    })
    let root = createRoot(document.querySelector<HTMLElement>("#app")!)
    root.render(<LanewayApp api={scenario.api} />)
    let settle = async () => {
        for (let index = 0; index < 8; index++) {
            await new Promise(resolve => setTimeout(resolve, 0))
            root.flush()
        }
    }
    try {
        await settle()
        let column = document.querySelector<HTMLElement>("[data-column-id='virtual:inspection']")!
        // Worktree controls live inside the column header: name on the left, overflow menu on the right.
        let row = column.querySelector<HTMLElement>(".column-worktree")!
        let header = column.querySelector<HTMLElement>("header")!
        let bounds = header.getBoundingClientRect()
        let body = column.querySelector<HTMLElement>(".column-inspection")!
        let compact = bounds.height <= 48 && Math.abs(body.getBoundingClientRect().top - bounds.bottom) <= 1
            && body.textContent!.includes("No Working Changes")
        row.querySelector<HTMLButtonElement>("[aria-label='Worktree actions']")!.click()
        await settle()
        let menu = row.querySelector<HTMLElement>("[role='menu']")!
        let removeItem = menu.querySelector<HTMLButtonElement>("button")!
        for (let attempt = 0; attempt < 100 && !removeItem.matches(":hover"); attempt++)
            await new Promise(resolve => setTimeout(resolve, 20))
        let hover = removeItem.matches(":hover") && getComputedStyle(removeItem).backgroundColor != getComputedStyle(menu).backgroundColor
            && getComputedStyle(removeItem).backgroundColor != "rgba(0, 0, 0, 0)"
        let menuBounds = menu.getBoundingClientRect()
        let overflow = menuBounds.left >= column.getBoundingClientRect().left && menuBounds.right <= column.getBoundingClientRect().right
            && Math.abs(menuBounds.top - bounds.bottom) <= 1 && body.getBoundingClientRect().top == bounds.bottom
            && menu.textContent!.includes("Remove worktree") && !menu.textContent!.includes("New worktree") && hover
        menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        // A maximized header isn't draggable, yet its path still ignores double-clicks that restore the columns.
        header.querySelector<HTMLButtonElement>("[aria-label='Maximize column']")!.click()
        await settle()
        let pathUnselectable = getComputedStyle(column.querySelector(".column-worktree-path")!).userSelect == "none"
        column.querySelector<HTMLButtonElement>("[aria-label='Restore columns']")!.click()
        await settle()
        let renameButton = row.querySelector<HTMLButtonElement>("[aria-label='Rename worktree']")!
        // The name and its rename input fit their text, leaving the rest of the header free.
        let titleWidth = renameButton.parentElement!.getBoundingClientRect().width
        let nameFits = pathUnselectable && renameButton.getBoundingClientRect().width < titleWidth / 2
        renameButton.click()
        await settle()
        let input = row.querySelector<HTMLInputElement>("input")!
        let inline = document.activeElement == input && input.value == "inspection" && header.getBoundingClientRect().height == bounds.height
            && nameFits && input.getBoundingClientRect().width < titleWidth / 2
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        let menuButton = row.querySelector<HTMLButtonElement>("[aria-label='Worktree actions']")!
        menuButton.click()
        await settle()
        row.querySelector<HTMLButtonElement>("[role='menu'] [aria-label='Switch worktree branch']")!.click()
        await settle()
        let search = row.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!
        let popup = row.querySelector<HTMLDialogElement>("dialog")!
        let searchable = popup.open && document.activeElement == search && popup.getBoundingClientRect().right <= innerWidth
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        let controls = compact && overflow && inline && searchable && document.activeElement == menuButton && !row.querySelector("dialog, input, details")
        scenario.api.previewWorktree = async (_id, request) => ({
            ok: true,
            preview: {
                request,
                worktrees: [],
                affected: ["D:/Source/inspection"],
                ignored: Array.from({ length: 20 }, (_, index) => `generated-${index}.bin`),
                ignoredCount: 250,
                dirty: false,
                uniqueCommits: false,
                populatedSubmodules: false,
                token: "preview",
            },
        })
        row.querySelector<HTMLButtonElement>("[aria-label='Worktree actions']")!.click()
        await settle()
        ;[...row.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find(item => item.textContent!.includes("Remove worktree"))!.click()
        await settle()
        let dialog = document.querySelector<HTMLDialogElement>("dialog[aria-label='Worktree operation']")!
        let remove = [...dialog.querySelectorAll("button")].find(button => button.textContent == "Remove worktree")!
        let styled = dialog.open && dialog.getBoundingClientRect().width <= 460 && remove.getBoundingClientRect().height >= 32
            && getComputedStyle(remove).backgroundColor != "rgba(0, 0, 0, 0)" && dialog.textContent!.includes("D:/Source/inspection")
            && dialog.textContent!.includes("generated-0.bin") && dialog.textContent!.includes("and 247 more")
            && !dialog.textContent!.includes("generated-3.bin")
            && dialog.scrollHeight <= innerHeight && !remove.disabled
        ;[...dialog.querySelectorAll("button")].find(button => button.textContent == "Cancel")!.click()
        await settle()
        return controls && styled && !document.querySelector("dialog[aria-label='Worktree operation']")
    } finally {
        root.dispose()
    }
}

async function checkRecoveryColumn() {
    let scenario = inspectionScenario()
    let recovery = {
        operationId: "c290421f-295c-4e27-8934-eeb57e63369c",
        worktreeId: "t3code-46aa28b8",
        path: "C:\\Users\\soxto\\.t3\\worktrees\\Laneway\\t3code-46aa28b8",
        head: scenario.graph.branches[2]!.tip,
        message: "Files remain in the worktree directory after its Git registration was removed.",
    }
    let previews = 0
    let preview = scenario.api.localOperation
    scenario.api.localOperation = async (...args) => {
        previews++
        return preview(...args)
    }
    scenario.api.readBranchGraph = async () => ({ ok: true, graph: scenario.graph, worktreeRecoveries: [recovery] })
    scenario.api.recoverWorktree = async () => ({ ok: false, error: { message: "Close the program holding the directory, then retry." } })
    Object.assign(scenario.saved().repositories[0]!.columns[0]!, { worktreeId: recovery.worktreeId, worktreePath: recovery.path })
    let container = document.querySelector<HTMLElement>("#app")!
    container.replaceChildren()
    let root = createRoot(container)
    root.render(<LanewayApp api={scenario.api} />)
    let settle = async () => {
        for (let index = 0; index < 8; index++) {
            await new Promise(resolve => setTimeout(resolve, 0))
            root.flush()
        }
    }
    await settle()
    let panel = document.querySelector<HTMLElement>(".worktree-recovery")!
    let buttons = [...panel.querySelectorAll<HTMLButtonElement>("button")]
    let path = panel.querySelector<HTMLElement>(".recovery-path")!
    let geometry = buttons.every(button => button.getBoundingClientRect().height >= 32)
        && path.scrollWidth <= path.clientWidth + 1 && panel.getBoundingClientRect().bottom <= innerHeight
        && panel.getBoundingClientRect().left >= 0 && panel.getBoundingClientRect().right <= innerWidth
    buttons.find(button => button.textContent == "Recover")!.click()
    await settle()
    return geometry && previews == 0 && document.querySelectorAll(".worktree-recovery").length == 1 && !document.querySelector(".commit-notice")
        && panel.querySelector("[role='alert']")?.textContent == "Close the program holding the directory, then retry."
}
