const { app } = require("electron")
const { writeFileSync } = require("node:fs")
const { join } = require("node:path")
const { pathToFileURL } = require("node:url")

const [directory, productionMain, phase] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    window.webContents.once("did-finish-load", async () => {
        try {
            const result = await window.webContents.executeJavaScript(`(async () => {
                const wait = async predicate => {
                    for (let i = 0; i < 600; i++) {
                        const result = predicate();
                        if (result) return result;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    throw new Error('UI timeout: ' + document.body.innerText);
                };
                const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() == text && !element.disabled);
                (await wait(() => button('Commit…'))).click();
                const title = await wait(() => document.querySelector('[aria-label="Commit title"]'));
                if (${JSON.stringify(phase)} == 'draft') {
                    title.value = 'Persistent desktop commit';
                    title.dispatchEvent(new Event('input', { bubbles: true }));
                    await wait(() => button('Cancel'));
                    button('Cancel').click();
                    // Reading waits for queued writes through the production IPC handler.
                    const state = await window.workbench.getState();
                    const repository = state.workspace.repositories[0];
                    const draft = await window.workbench.readCommitDraft(repository.id, repository.info.mainWorktree);
                    if (draft.title != 'Persistent desktop commit') throw new Error('Draft was not saved');
                    return { draft: true };
                }
                if (title.value != 'Persistent desktop commit') throw new Error('Draft was not restored across restart');
                (await wait(() => button('Commit all changes (1)'))).click();
                await wait(() => !document.querySelector('[aria-label="Commit title"]') && document.body.innerText.includes('No Working Changes'));
                (await wait(() => document.querySelector('[data-column-id="branch:refs/heads/main"] header'))).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 100 }));
                (await wait(() => button('Create branch here…'))).click();
                const name = await wait(() => document.querySelector('[aria-label="Branch name"]'));
                name.value = 'alias'; name.dispatchEvent(new Event('input', { bubbles: true }));
                (await wait(() => button('Create branch'))).click();
                const alias = await wait(() => document.querySelector('[data-column-id="branch:refs/heads/alias"]'));
                if (alias.querySelector('.commit-composer')) throw new Error('Branch creation unexpectedly checked out the branch');
                alias.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
                const rename = await wait(() => document.querySelector('[aria-label="Branch name"]'));
                rename.value = 'renamed'; rename.dispatchEvent(new Event('input', { bubbles: true }));
                (await wait(() => button('Rename'))).click();
                const renamed = await wait(() => document.querySelector('[data-column-id="branch:refs/heads/renamed"]'));
                renamed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
                (await wait(() => button('Delete'))).click();
                await wait(() => !document.querySelector('[data-column-id="branch:refs/heads/renamed"]'));
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
import(pathToFileURL(productionMain).href).catch(error => { console.error(error); app.exit(1) })
