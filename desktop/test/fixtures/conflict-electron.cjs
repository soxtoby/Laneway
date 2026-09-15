const { app } = require("electron")
const { writeFileSync } = require("node:fs")
const { join } = require("node:path")
const { pathToFileURL } = require("node:url")
const [directory, productionMain, phase] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    window.webContents.setBackgroundThrottling(false)
    const deadline = setTimeout(async () => {
        const body = await window.webContents.executeJavaScript('document.body.innerText').catch(String)
        writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: 'Timed out', body }))
        app.exit(1)
    }, 85000)
    window.webContents.once("did-finish-load", async () => {
        try {
            const result = await window.webContents.executeJavaScript(`(async () => {
                const violations = [];
                document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
                const wait = async predicate => {
                    for (let i = 0; i < 800; i++) {
                        const value = predicate(); if (value) return value;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    throw new Error('UI timeout: ' + document.body.innerText);
                };
                const button = (text, scope = document) => [...scope.querySelectorAll('button')].find(b => (b.textContent.trim() == text || b.getAttribute('aria-label') == text) && !b.disabled);
                await wait(() => document.querySelector('button[aria-label$="appearance"]'));
                document.querySelector('button[aria-label="Switch to light appearance"]')?.click();
                await wait(() => document.documentElement.dataset.appearance == 'light');
                if (${JSON.stringify(phase)} != 'accept') {
                    const toggle = await wait(() => document.querySelector('[aria-label="Show only conflicted commits"]'));
                    await wait(() => document.querySelectorAll('.inspect-commit').length == 2);
                    if (document.querySelector('[aria-label="Unresolved conflicts"]')) throw new Error('Duplicate conflict list');
                    toggle.click();
                    await wait(() => toggle.getAttribute('aria-pressed') == 'true' && document.querySelectorAll('.inspect-commit').length == 1);
                    if (!document.querySelector('.inspect-commit').textContent.includes('topic change')) throw new Error('Filtered wrong commit');
                    toggle.click();
                    await wait(() => toggle.getAttribute('aria-pressed') == 'false' && document.querySelectorAll('.inspect-commit').length == 2);
                    const indicator = await wait(() => document.querySelector('[aria-label="Resolve conflicts in topic change"]'));
                    const rowBounds = indicator.closest('h4').getBoundingClientRect(), indicatorBounds = indicator.getBoundingClientRect();
                    if (Math.abs(rowBounds.top - indicatorBounds.top) > 0.5 || Math.abs(rowBounds.bottom - indicatorBounds.bottom) > 0.5) throw new Error('Conflict indicator does not fill commit row');
                    indicator.click();
                    const column = await wait(() => document.querySelector('[aria-label="Conflict Resolution Column"]'));
                    const files = await wait(() => column.querySelector('[aria-label="Conflicted files"]'));
                    await wait(() => files.querySelectorAll('.conflict-file').length == 3);
                    const row = path => [...files.querySelectorAll('.conflict-file')].find(item => item.dataset.file == path);
                    if (column.querySelector('.conflict-versions, .source-lines, .pierre-diff')) throw new Error('File list replaced by inline resolution');
                    for (const item of files.children) {
                        if (!button('Use updated stack', item) || !button('Use this commit', item) || !button('Merge tool', item)) throw new Error('File actions are missing');
                        const heading = item.querySelector('.change-file');
                        if (!heading || heading.getBoundingClientRect().height > 30) throw new Error('Conflict file is not a compact inspection row');
                        if (getComputedStyle(item.querySelector('.file-name')).fontFamily.includes('Consolas')) throw new Error('Conflict filenames do not match commit files');
                        for (const control of item.querySelectorAll('.conflict-file-actions > button')) {
                            if (Math.abs(control.getBoundingClientRect().height - 22) > 0.5) throw new Error('File action size differs from commit controls');
                        }
                    }
                    if (column.innerText.includes('<<<<<<<') || column.innerText.includes('Replayed commit ') || column.innerText.includes('Candidate')) throw new Error('Diagnostic conflict content is visible');
                    const menu = row('contact.txt').querySelector('.resolution-menu');
                    menu.querySelector('summary').click();
                    await wait(() => menu.open);
                    const menuItem = button('Use current file', menu), menuBounds = menuItem.getBoundingClientRect();
                    const hit = document.elementFromPoint(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height / 2);
                    if (!menuItem.contains(hit)) throw new Error('File menu obscured: ' + JSON.stringify({ bounds: menuBounds.toJSON(), hit: hit?.outerHTML.slice(0, 500), rowZ: getComputedStyle(menu.closest('.change-file')).zIndex }));
                    menu.querySelector('summary').click();
                    if (${JSON.stringify(phase)} == 'unresolved') {
                        const state = await window.workbench.getState();
                        await window.workbench.updateWorkspace(state.workspace);
                        if (violations.length) throw new Error('CSP: ' + violations.join(','));
                        return { unresolved: true };
                    }
                    button('Use updated stack', row('file.txt')).click();
                    await wait(() => row('file.txt').dataset.resolved == 'true' && button('Discard resolution progress', column));
                    if (button('Accept resolution', column)) throw new Error('Partial resolution can be accepted');
                    button('Discard resolution progress', column).click();
                    await wait(() => row('file.txt').dataset.resolved == 'false' && button('Use this commit', row('file.txt')));
                    button('Use this commit', row('file.txt')).click();
                    await wait(() => row('file.txt').dataset.resolved == 'true' && button('Use updated stack', row('payment.txt')));
                    button('Use updated stack', row('payment.txt')).click();
                    await wait(() => row('payment.txt').dataset.resolved == 'true' && button('Merge tool', row('contact.txt')));
                    if (button('Accept resolution', column)) throw new Error('Unresolved files can be accepted');
                    button('Merge tool', row('contact.txt')).click();
                    await wait(() => button('Accept resolution', column));
                    if (files.querySelectorAll('[data-resolved="true"]').length != 3) throw new Error('Resolved files did not stay in the list');
                    if (column.querySelector('.pierre-diff')) throw new Error('Review opened automatically');
                    const review = row('file.txt').querySelector('button[title="file.txt"]');
                    review.click();
                    const diff = await wait(() => {
                        const root = column.querySelector('.pierre-diff')?.shadowRoot;
                        return root?.textContent.includes('Delivery: next business day.') && root;
                    });
                    if (!diff.textContent.includes('Delivery: next business day.') || diff.textContent.includes('<<<<<<< Updated stack')) throw new Error('Resolution review is not a normal diff');
                    review.click();
                    await wait(() => !column.querySelector('.pierre-diff'));
                    const bounds = column.getBoundingClientRect();
                    if (bounds.width < 350 || bounds.height < 200) throw new Error('Resolution column did not lay out');
                    const state = await window.workbench.getState();
                    await window.workbench.updateWorkspace(state.workspace);
                    if (violations.length) throw new Error('CSP: ' + violations.join(','));
                    return { candidate: true };
                }
                const column = await wait(() => document.querySelector('[aria-label="Conflict Resolution Column"]'));
                const accept = await wait(() => button('Accept resolution', column));
                if (column.querySelectorAll('.conflict-file[data-resolved="true"]').length != 3) throw new Error('File resolution progress did not survive restart');
                accept.click();
                await wait(() => !document.querySelector('[aria-label="Conflict Resolution Column"]') && !document.querySelector('[aria-label="Unresolved conflicts"]'));
                if (violations.length) throw new Error('CSP: ' + violations.join(','));
                return { accepted: true };
            })()`)
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify(result))
            clearTimeout(deadline)
            if (phase != "accept") {
                writeFileSync(join(directory, `${phase}.png`), (await window.webContents.capturePage()).toPNG())
                await window.webContents.executeJavaScript(`(async () => {
                    document.querySelector('button[aria-label="Switch to dark appearance"]').click();
                    for (let i = 0; i < 100; i++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const column = document.querySelector('.conflict-resolution-column');
                        if (getComputedStyle(column).backgroundColor == 'rgb(33, 38, 33)' && (await window.workbench.getState()).appearance == 'dark') return;
                    }
                    throw new Error('Conflict column did not adopt dark appearance');
                })()`)
                writeFileSync(join(directory, `${phase}-dark.png`), (await window.webContents.capturePage()).toPNG())
            }
            app.exit(0)
        } catch (error) {
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: String(error.stack || error) }))
            app.exit(1)
        }
    })
})
import(pathToFileURL(productionMain).href)
