let { app } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")

// Drives the built app's React page through one phase of react-local-electron.test.ts.
let [directory, productionMain, phase] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    // React Aria restores focus and opens overlays on animation frames, which a hidden window would hold.
    window.webContents.setBackgroundThrottling(false)
    window.webContents.once("did-finish-load", async () => {
        try {
            let result = await window.webContents.executeJavaScript(`(async () => {
                const wait = async predicate => {
                    for (let i = 0; i < 600; i++) {
                        const result = predicate();
                        if (result) return result;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    throw new Error('UI timeout: ' + document.body.innerText);
                };
                const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() == text && !element.disabled);
                // React tracks an input's value, so typing goes through the element's own setter.
                const type = (input, value) => {
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                };
                (await wait(() => button('Commit…'))).click();
                const title = await wait(() => document.querySelector('[aria-label="Commit title"]'));
                if (${JSON.stringify(phase)} == 'draft') {
                    type(title, 'Persistent desktop commit');
                    (await wait(() => button('Cancel'))).click();
                    // Reading waits for queued writes through the production IPC handler.
                    const state = await window.laneway.getState();
                    const repository = state.workspace.repositories[0];
                    const draft = await window.laneway.readCommitDraft(repository.id, repository.info.mainWorktree);
                    if (draft.title != 'Persistent desktop commit') throw new Error('Draft was not saved');
                    return { draft: true };
                }
                if (title.value != 'Persistent desktop commit') throw new Error('Draft was not restored across restart');
                (await wait(() => button('Commit all changes (1)'))).click();
                await wait(() => !document.querySelector('[aria-label="Commit title"]') && document.body.innerText.includes('No Working Changes'));
                return { committed: true };
            })()`)
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify(result))
            app.quit()
        } catch (error) {
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: String(error) }))
            app.exit(1)
        }
    })
})
import(pathToFileURL(productionMain).href).catch(error => {
    console.error(error)
    app.exit(1)
})
