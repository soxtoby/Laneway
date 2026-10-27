let { app } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")

// Opens a file's diff in the built app's maximized branch column, restores the column, and reports what the window
// reported meanwhile; react-maximized-diff-electron.test.ts checks the report.
let [directory, productionMain] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    // The diff measures its new width, and React Aria its list, on animation frames, which a hidden window would hold.
    window.webContents.setBackgroundThrottling(false)
    window.webContents.once("did-finish-load", async () => {
        try {
            let result = await window.webContents.executeJavaScript(`(async () => {
                // What the browser reports to the window, such as a ResizeObserver loop that couldn't settle.
                const errors = [];
                window.addEventListener('error', event => errors.push(event.message));
                const wait = async (predicate, what) => {
                    for (let i = 0; i < 300; i++) {
                        const result = predicate();
                        if (result) return result;
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                    throw new Error('Timed out waiting for ' + what + ': ' + document.body.innerText.slice(0, 500));
                };
                const frames = async count => {
                    for (let i = 0; i < count; i++)
                        await new Promise(resolve => requestAnimationFrame(resolve));
                };
                const settled = async () => {
                    await wait(() => document.getAnimations().length == 0, 'the columns to settle');
                    await frames(10);
                };
                const fileRow = '[aria-label="Working Changes"] [role=row]';
                const column = (await wait(() => document.querySelector(fileRow), 'the file row')).closest('.column');

                column.querySelector('[aria-label="Maximize column"]').click();
                await wait(() => document.querySelector('.column-group.maximized'), 'the maximized column');
                await settled();
                document.querySelector(fileRow + ' .file-path').click();
                const host = await wait(() => column.querySelector('.pierre-diff')?.shadowRoot?.querySelector('[data-code]') && column.querySelector('.pierre-diff'), 'the diff');
                await settled();
                const scrollbar = host.parentElement.querySelector('.diff-scrollbar');
                const maximized = { scrollbar: !scrollbar.hidden };

                column.querySelector('[aria-label="Restore column"]').click();
                await wait(() => !document.querySelector('.column-group.maximized'), 'the restored column');
                await settled();
                const restored = { scrollbar: !scrollbar.hidden };
                return { maximized, restored, errors };
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
