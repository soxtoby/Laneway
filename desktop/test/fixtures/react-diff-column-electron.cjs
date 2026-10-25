let { app } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")

// Opens the built app's Working Changes diff column and reports which of its diffs, toolbars, and source rows are drawn;
// react-diff-column-electron.test.ts checks the report.
let [directory, productionMain] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    // The renderer learns which diffs are near the view on animation frames, which a hidden window would hold.
    window.webContents.setBackgroundThrottling(false)
    window.webContents.once("did-finish-load", async () => {
        try {
            let result = await window.webContents.executeJavaScript(`(async () => {
                const wait = async (predicate, what) => {
                    for (let i = 0; i < 300; i++) {
                        const result = predicate();
                        if (result) return result;
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                    throw new Error('Timed out waiting for ' + what);
                };
                const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
                const sections = () => [...document.querySelectorAll('.diff-column [data-diff-path]')];
                const host = section => section.querySelector('.pierre-diff');
                const drawn = section => !!host(section)?.shadowRoot?.querySelector('[data-code]');
                const named = name => sections().find(section => section.dataset.diffPath == name);
                // A file's toolbar draws its controls once the file nears the view; before then it shows only the file.
                const controls = section => !!section.querySelector('button.diff-file-toggle');
                const last = 'file-071.ts';

                (await wait(() => document.querySelector('[aria-label="Open diff column"]:not([disabled])'), 'Working Changes')).click();
                await wait(() => sections().length == 72 && sections().every(host), 'every diff to load');
                await wait(() => drawn(sections()[0]), 'the first diff to draw');
                // Long enough for anything that wrongly draws to have drawn.
                await pause(500);
                const opened = {
                    drawn: sections().filter(drawn).map(section => section.dataset.diffPath),
                    lastHoldsItsPlace: !drawn(named(last)) && host(named(last)).getBoundingClientRect().height > 1000,
                    lastToolbarWaits: !controls(named(last)),
                    sourceRows: document.querySelectorAll('[aria-label="Working Changes"] .file-row').length,
                };

                // Folding the files above a diff brings it into view without scrolling.
                for (const name of ['file-000.ts', 'file-001.ts', 'file-002.ts'])
                    named(name).querySelector('.diff-file-toggle').click();
                await wait(() => drawn(named('file-003.ts')), 'the diff the folded files uncovered to draw');

                const files = document.querySelector('.diff-column-files');
                files.scrollTop = files.scrollHeight;
                await wait(() => drawn(named(last)) && controls(named(last)), 'the last diff and its toolbar to draw once scrolled to');

                // Choosing a file far up the source list glides the column to it, through diffs that draw as it nears.
                const chosen = 'file-030.ts';
                const body = document.querySelector('.column-body');
                const row = () => document.querySelector('[aria-label="Working Changes"] [data-row-key="' + chosen + '"]');
                body.scrollTop = 0;
                for (let i = 0; i < 100 && !row(); i++) {
                    body.scrollTop += 200;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                }
                const tops = [];
                let recording = true;
                const record = () => {
                    tops.push(files.scrollTop);
                    if (recording) requestAnimationFrame(record);
                };
                requestAnimationFrame(record);
                row().click();
                await pause(1500);
                recording = false;
                const steps = tops.slice(1).map((top, index) => top - tops[index]).filter(step => step != 0);
                const section = named(chosen);
                const pinned = parseFloat(getComputedStyle(section.querySelector('.diff-toolbar')).top) || 0;
                const glided = {
                    through: steps.length > 5,
                    oneWay: steps.every(step => Math.sign(step) == Math.sign(steps[0])),
                    landed: Math.abs(section.getBoundingClientRect().top - files.getBoundingClientRect().top - pinned) <= 1,
                };
                return { opened, uncovered: true, scrolled: true, glided };
            })()`)
            writeFileSync(join(directory, "result.json"), JSON.stringify(result))
            app.quit()
        } catch (error) {
            writeFileSync(join(directory, "result.json"), JSON.stringify({ error: String(error) }))
            app.exit(1)
        }
    })
})
import(pathToFileURL(productionMain).href).catch(error => {
    console.error(error)
    app.exit(1)
})
