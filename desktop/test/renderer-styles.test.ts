import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

test("Remix renderer styles and controls work under production CSP in Electron", async () => {
    const temporaryRoot = await realpath(tmpdir())
    const directory = await mkdtemp(join(temporaryRoot, "workbench-renderer-"))
    try {
        const build = await Bun.build({
            entrypoints: [join(import.meta.dir, "fixtures/renderer-styles.tsx")],
            outdir: directory,
            target: "browser",
        })
        expect(build.success).toBe(true)
        const html = (await readFile(join(import.meta.dir, "../src/renderer/index.html"), "utf8"))
            .replace("./src/styles.css", "./styles.css")
            .replace("./src/main.tsx", "./renderer-styles.js")
        await writeFile(join(directory, "index.html"), html)
        await writeFile(join(directory, "styles.css"), await readFile(join(import.meta.dir, "../src/renderer/src/styles.css")))
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        const exitCode = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/renderer-electron.cjs"), directory], {
                env,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
                timeout: 20_000,
            })
            child.stderr.on("data", chunk => errors += String(chunk))
            child.on("error", reject)
            child.on("close", resolve)
        })
        const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"))
        expect({ exitCode, error: result.error }, errors).toEqual({ exitCode: 0, error: undefined })
        expect(result).toMatchObject({
            compactSplit: true,
            balancedMetadata: true,
            compactUnified: true,
            inlineDiff: true,
            flatFiles: true,
            hunkSelected: true,
            distinctLineEndings: true,
            endingsStayOnRow: true,
            endingRowsAligned: true,
            adjacentDiffs: true,
            independentDiffs: true,
            noInnerVerticalScroll: true,
            outerDiffScroll: true,
            breakoutDiffScroll: true,
            inlineDiffsHiddenAfterBreakout: true,
            breakoutSwitched: true,
            breakoutSwitchedTo: "Diff for src/example.ts",
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
            darkBackground: "rgb(33, 38, 33)",
            radioBackground: "rgb(182, 217, 95)",
            branchExpanded: true,
            commitExpanded: true,
            commitGraph: true,
            commitDiffClear: true,
            commitCollapsed: true,
            accordionKeyboard: true,
            radioChecked: true,
            modal: true,
            navigated: true,
            searchKeptFocus: true,
            emptyCleared: true,
            restoredFocus: true,
            activatedBranch: true,
            violations: [],
        })
        expect(result.stylesheets).toBeGreaterThan(0)
    } finally {
        if (dirname(await realpath(directory)) != temporaryRoot)
            throw new Error(`Unexpected renderer test directory: ${directory}`)
        await rm(directory, { recursive: true, force: true })
    }
}, 30_000)
