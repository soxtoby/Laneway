import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

test("Remix renderer styles and controls work under production CSP in Electron", async () => {
    let temporaryRoot = await realpath(tmpdir())
    let directory = await mkdtemp(join(temporaryRoot, "laneway-renderer-"))
    try {
        let build = await Bun.build({
            entrypoints: [join(import.meta.dir, "fixtures/renderer-styles.tsx")],
            outdir: directory,
            target: "browser",
        })
        expect(build.success).toBe(true)

        let html = (await readFile(join(import.meta.dir, "../src/renderer/index.html"), "utf8"))
            .replace("./src/styles.css", "./styles.css")
            .replace("./src/main.tsx", "./renderer-styles.js")
        await writeFile(join(directory, "index.html"), html)
        await writeFile(join(directory, "styles.css"), await readFile(join(import.meta.dir, "../src/renderer/src/styles.css")))

        let env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        let exitCode = await new Promise<number | null>((resolve, reject) => {
            let child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/renderer-electron.cjs"), directory], {
                env,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
                timeout: 60_000,
            })
            child.stderr.on("data", chunk => errors += String(chunk))
            child.on("error", reject)
            child.on("close", resolve)
        })
        let failure = exitCode == 0 ? "" : await readFile(join(directory, "result.json"), "utf8").catch(() => "")
        expect(exitCode, failure || errors || "Electron exited before completing the renderer checks (60-second timeout).").toBe(0)
        let result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"))
        expect({ exitCode, error: result.error }, errors).toEqual({ exitCode: 0, error: undefined })
        expect(result).toMatchObject({
            worktreePreview: true,
            edgeDropAbove: true,
            edgeDropCentre: true,
            dragKeepsLayout: true,
            dragCleared: true,
            worktreeCancelled: true,
            worktreeRowCompact: true,
            virtualWorktreeCompact: true,
            worktreeRecovery: true,
            historySingleLine: true,
            historyStickyRow: true,
            historyDirectDiff: true,
            historyAddedFileScroll: true,
            graphScrollDrift: 0,
            comparisonOpened: true,
            comparisonLazy: true,
            comparisonPatch: true,
            comparisonGeometry: true,
            comparisonClosed: true,
            collapsedColumnCompact: true,
            columnToggleStable: true,
            columnCollapseStillAtLeft: true,
            expandedWidthRestored: true,
            graphFullyHidden: true,
            graphRestored: true,
            columnsMeetRail: true,
            columnScrollbarBelow: true,
            columnsReachEdges: true,
            hideGraphButtonCompact: true,
            showGraphButtonCompact: true,
            branchToggleHasIcon: true,
            graphToggleStaysInRail: true,
            graphSettingsAnchored: true,
            compactSplit: true,
            balancedMetadata: true,
            compactUnified: true,
            inlineDiff: true,
            auxiliarySourceVisible: true,
            maximizedSplit: true,
            breakoutResizable: true,
            breakoutScrollbarClear: true,
            breakoutStickyTop: true,
            flatFiles: true,
            pressLeavesFileCollapsed: true,
            expandedOnClick: true,
            pressLeavesFileUnselected: true,
            selectedOnClick: true,
            lineSelected: true,
            contextExpansionVisible: true,
            distinctLineEndings: true,
            endingsStayOnRow: true,
            endingRowsAligned: true,
            adjacentDiffs: true,
            independentDiffs: true,
            noInnerVerticalScroll: true,
            outerDiffScroll: true,
            breakoutDiffScroll: true,
            inlineDiffsHiddenAfterBreakout: true,
            breakoutWholeCommit: true,
            breakoutOpenedAtFile: true,
            breakoutScrolledToFile: true,
            breakoutCollapsed: true,
            breakoutNavigationExpands: true,
            breakoutExpanded: true,
            newlineNotice: true,
            stickyFileRow: true,
            stickyCommitRow: true,
            stickyCommitOpaque: true,
            compactFileControls: true,
            literalSelection: true,
            alignedSplit: true,
            linkedFromLeft: true,
            linkedFromRight: true,
            unequalWidthsStable: true,
            linkedAfterRender: true,
            diffLineHeight: 24,
            syntaxHighlighted: true,
            intraLineHighlight: true,
            whitespaceDefaultOff: true,
            whitespaceVisible: true,
            lineEndingsVisible: true,
            whitespaceHidden: true,
            lightBackground: "rgb(255, 255, 255)",
            darkBackground: "rgb(28, 34, 45)",
            radioBackground: "rgb(242, 169, 44)",
            branchExpanded: true,
            commitTooltip: true,
            commitBodyIndicator: true,
            commitDescriptionCollapsible: true,
            expandedCommitMessage: true,
            commitExpanded: true,
            commitGraph: true,
            branchGraphConnected: true,
            branchGraphColors: true,
            branchGraphThemeColors: true,
            commitDiffClear: true,
            commitCollapsed: true,
            accordionKeyboard: true,
            radioChecked: true,
            singleCardEdge: true,
            stickyDiffScrollbar: true,
            modal: true,
            navigated: true,
            searchKeptFocus: true,
            emptyCleared: true,
            restoredFocus: true,
            activatedBranch: true,
            contextMenuCompact: true,
            comparisonControls: true,
            comparisonStickyRow: true,
            comparisonColumnHeader: true,
            comparisonHeadingTruncates: true,
            historyTrail: true,
            historyTrailClosed: true,
            comparisonSharedRows: true,
            comparisonRefreshStable: true,
            comparisonPatchRefreshStable: true,
            violations: [],
        })
        expect(result.stylesheets).toBeGreaterThan(0)
    } finally {
        if (dirname(await realpath(directory)) != temporaryRoot)
            throw new Error(`Unexpected renderer test directory: ${directory}`)
        await rm(directory, { recursive: true, force: true })
    }
}, 90_000)
