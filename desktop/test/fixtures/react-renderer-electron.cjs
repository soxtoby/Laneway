let { app } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")

// Loads the built app's React page and measures it in light and dark; react-renderer-styles.test.ts
// checks the measurements.
let [directory, productionMain] = process.argv.slice(2)
let problems = []
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    // React Aria opens popovers and restores focus on animation frames, which a hidden window would hold.
    window.webContents.setBackgroundThrottling(false)
    window.webContents.on("console-message", event => {
        if (event.level == "warning" || event.level == "error")
            problems.push(event.message)
    })
    window.webContents.once("did-finish-load", async () => {
        try {
            let result = await window.webContents.executeJavaScript(`(async () => {
                const wait = async (predicate, what) => {
                    for (let i = 0; i < 300; i++) {
                        const result = predicate();
                        if (result) return result;
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                    throw new Error('Timed out waiting for ' + what + ': ' + document.body.innerText.slice(0, 500));
                };
                const hex = color => {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d');
                    context.fillStyle = color;
                    context.fillRect(0, 0, 1, 1);
                    return '#' + [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('');
                };
                const background = selector => hex(getComputedStyle(document.querySelector(selector)).backgroundColor);
                const height = selector => document.querySelector(selector).getBoundingClientRect().height;
                const fileRow = '[aria-label="Working Changes"] [role=row]';
                const commitRow = '[aria-label^="Commits on"] [role=row]';
                const repositoryRow = '[aria-label="Open repositories"] [role=row]';
                const colors = () => ({
                    body: background('body'),
                    header: background('header'),
                    panel: background('.repository-panel'),
                    accent: background('.button-base[data-variant="accent"]'),
                });

                await wait(() => document.querySelector(fileRow) && document.querySelector(commitRow), 'the column');
                const light = colors();
                const geometry = { header: height('header'), fileRow: height(fileRow), commitRow: height(commitRow), collapsedRepositoryRow: height(repositoryRow) };
                document.querySelector('button[aria-label="Expand repository sidebar"]').click();
                await wait(() => document.querySelector('button[aria-label="Collapse repository sidebar"]'), 'the expanded panel');
                geometry.repositoryRow = height(repositoryRow);

                const row = document.querySelector(fileRow);
                const rect = row.getBoundingClientRect();
                row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.x + 20, clientY: rect.y + 10 }));
                const menu = await wait(() => document.querySelector('[role=menu]'), 'the context menu');
                await wait(() => document.getAnimations().length == 0, 'the menu to settle');
                const menuRect = menu.getBoundingClientRect();
                const contextMenu = { items: [...menu.querySelectorAll('[role=menuitem]')].map(item => item.textContent), atPointer: Math.abs(menuRect.x - rect.x - 20) <= 1 && Math.abs(menuRect.y - rect.y - 10) <= 1 };
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                await wait(() => !document.querySelector('[role=menu]'), 'the context menu to close');

                // A dialog taller than half the window stays centred.
                document.querySelector('header button[aria-label="Git settings"]').click();
                const dialog = await wait(() => document.querySelector('[role=dialog]'), 'Git settings');
                await wait(() => document.getAnimations().length == 0, 'the dialog to settle');
                const dialogRect = dialog.getBoundingClientRect();
                const settingsDialog = {
                    tall: dialogRect.height > innerHeight / 2,
                    centred: Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) <= 1 && Math.abs(dialogRect.left + dialogRect.width / 2 - innerWidth / 2) <= 1,
                };
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                await wait(() => !document.querySelector('[role=dialog]'), 'Git settings to close');

                document.querySelector('header button[aria-label="Switch to dark appearance"]').click();
                await wait(() => matchMedia('(prefers-color-scheme: dark)').matches && document.querySelector('header button[aria-label="Switch to light appearance"]'), 'the dark appearance');
                await wait(() => document.getAnimations().length == 0, 'the appearance transitions');
                const dark = colors();

                return { light, dark, geometry, contextMenu, settingsDialog, styleElements: document.querySelectorAll('style').length };
            })()`)
            writeFileSync(join(directory, "result.json"), JSON.stringify({ ...result, problems }))
            app.quit()
        } catch (error) {
            writeFileSync(join(directory, "result.json"), JSON.stringify({ error: String(error), problems }))
            app.exit(1)
        }
    })
})
import(pathToFileURL(productionMain).href).catch(error => {
    console.error(error)
    app.exit(1)
})
