let { app, ipcMain } = require("electron")
let conflictReads = []
let originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
    let started = performance.now()
    let result = await listener(...args)
    if (channel == 'conflict:content' || channel == 'conflict:operation')
        conflictReads.push({ channel, request: args[2], ms: performance.now() - started })
    return result
})
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")
let [directory, productionMain, phase] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    window.webContents.setBackgroundThrottling(false)
    let deadline = setTimeout(async () => {
        let body = await window.webContents.executeJavaScript('({ text: document.body.innerText, waiting: window.lastWait, csp: window.cspViolations })').catch(String)
        writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: 'Timed out', body }))
        app.exit(1)
    }, 85000)
    window.webContents.once("did-finish-load", async () => {
        try {
            let result = await window.webContents.executeJavaScript(`(async () => {
                const violations = window.cspViolations = [];
                const errors = [];
                window.addEventListener('error', e => errors.push(e.error?.stack || e.message));
                window.addEventListener('unhandledrejection', e => errors.push(String(e.reason?.stack || e.reason)));
                document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
                const wait = async predicate => {
                    window.lastWait = predicate.toString();
                    for (let i = 0; i < 800; i++) {
                        if (errors.length) throw new Error(errors.join('\\n'));
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
                    const lowerIndicator = await wait(() => document.querySelector('.stack-heading [aria-label="lower has unresolved conflicts"]'));
                    const lowerHeading = lowerIndicator.closest('button');
                    if (lowerHeading.getAttribute('aria-expanded') != 'false') throw new Error('Lower branch should initially be collapsed');
                    if (document.querySelector('.stack-heading [aria-label="main has unresolved conflicts"]')) throw new Error('Clean base marked conflicted');
                    lowerHeading.click();
                    await wait(() => document.querySelectorAll('.inspect-commit').length == 2);
                    if (!document.contains(lowerIndicator)) throw new Error('Expanding the branch lost its conflict indicator');
                    if (document.querySelector('[aria-label="Unresolved conflicts"]')) throw new Error('Duplicate conflict list: ' + document.querySelector('[aria-label="Unresolved conflicts"]').textContent);
                    toggle.click();
                    await wait(() => toggle.getAttribute('aria-pressed') == 'true' && document.querySelectorAll('.inspect-commit').length == 1);
                    if (!document.querySelector('.inspect-commit').textContent.includes('topic change')) throw new Error('Filtered wrong commit');
                    toggle.click();
                    await wait(() => toggle.getAttribute('aria-pressed') == 'false' && document.querySelectorAll('.inspect-commit').length == 2);
                    const indicator = await wait(() => document.querySelector('[aria-label="Resolve conflicts in topic change"]'));
                    const commitRow = indicator.closest('h4'), rowBounds = commitRow.getBoundingClientRect(), indicatorBounds = indicator.getBoundingClientRect();
                    // The row's bottom border is its separator line, so the indicator fills the row above it.
                    const rowBottom = rowBounds.bottom - parseFloat(getComputedStyle(commitRow).borderBottomWidth);
                    if (Math.abs(rowBounds.top - indicatorBounds.top) > 0.5 || Math.abs(rowBottom - indicatorBounds.bottom) > 0.5) throw new Error('Conflict indicator does not fill commit row');
                    if (${JSON.stringify(phase)} == 'candidate') indicator.closest('.inspect-commit').querySelector('.commit-heading').click();
                    else indicator.click();
                    const column = await wait(() => document.querySelector('[aria-label="Conflict resolution"]'));
                    if (!column.closest('.inspect-commit') || document.querySelector('.conflict-resolution-column')) throw new Error('Resolution is not inline in the commit');
                    const files = await wait(() => column.querySelector('[aria-label="Commit files"] .file-tree'));
                    await wait(() => files.querySelectorAll('.conflict-file').length == 3);
                    const row = path => [...files.querySelectorAll('.conflict-file')].find(item => item.dataset.file == path);
                    if (column.querySelector('.conflict-versions, .source-lines, .pierre-diff')) throw new Error('File list replaced by inline resolution');
                    for (const item of files.querySelectorAll('.conflict-file')) {
                        if (!button('Use version before this commit', item) || !button('Use this commit', item) || !button('Merge tool', item)) throw new Error('File actions are missing');
                        const heading = item.querySelector('.change-file');
                        if (!heading || heading.getBoundingClientRect().height > 30) throw new Error('Conflict file is not a compact inspection row');
                        if (getComputedStyle(item.querySelector('.file-name')).fontFamily.includes('Consolas')) throw new Error('Conflict filenames do not match commit files');
                        for (const control of item.querySelectorAll('.conflict-file-actions > button')) {
                            if (Math.abs(control.getBoundingClientRect().height - 22) > 0.5) throw new Error('File action size differs from commit controls');
                        }
                    }
                    const cleanFile = await wait(() => files.querySelector('button[title="notes.txt"]'));
                    cleanFile.click();
                    await wait(() => column.querySelector('.pierre-diff')?.shadowRoot?.textContent.includes('A clean file in the conflicted commit'));
                    cleanFile.click();
                    await wait(() => !column.querySelector('.pierre-diff'));
                    if (column.innerText.includes('<<<<<<<') || column.innerText.includes('Replayed commit ') || column.innerText.includes('Candidate')) throw new Error('Diagnostic conflict content is visible');
                    const menu = row('contact.ts').querySelector('.resolution-menu');
                    menu.querySelector('summary').click();
                    await wait(() => menu.open);
                    const menuItem = button('Use current file', menu), menuBounds = menuItem.getBoundingClientRect();
                    const hit = document.elementFromPoint(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height / 2);
                    if (!menuItem.contains(hit)) throw new Error('File menu obscured: ' + JSON.stringify({ bounds: menuBounds.toJSON(), hit: hit?.outerHTML.slice(0, 500), rowZ: getComputedStyle(menu.closest('.change-file')).zIndex }));
                    menu.querySelector('summary').click();
                    if (${JSON.stringify(phase)} == 'unresolved') {
                        row('file.txt').querySelector('button[title="file.txt"]').click();
                        await wait(() => row('file.txt').querySelector('.pierre-merge')?.shadowRoot?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'));
                        const state = await window.laneway.getState();
                        await window.laneway.updateWorkspace(state.workspace);
                        if (violations.length) throw new Error('CSP: ' + violations.join(','));
                        return { unresolved: true };
                    }
                    const review = () => row('file.txt').querySelector('button[title="file.txt"]');
                    const root = () => row('file.txt').querySelector('.pierre-merge')?.shadowRoot?.querySelector('diffs-container')?.shadowRoot;
                    review().click();
                    await wait(() => root()?.querySelector('[data-merge-conflict-action="incoming"]'));
                    const markerLabels = [...root().querySelectorAll('[data-merge-conflict-marker-row] > span')].map(row => row.textContent);
                    if (!markerLabels.includes('Before this commit') || !markerLabels.includes('This commit')) throw new Error('Conflict sides are not clearly labelled: ' + markerLabels.join(','));
                    for (const [action, kind] of [['current', 'marker-start'], ['incoming', 'marker-end']]) {
                        const control = root().querySelector('[data-merge-conflict-action="' + action + '"]');
                        if (control.textContent != 'Keep this' || control.parentElement.dataset.mergeConflict != kind) throw new Error('Keep this is not in its side heading: ' + action);
                    }
                    if (root().querySelector('[data-merge-conflict-action="both"]').textContent != 'Keep both') throw new Error('Keep both missing');
                    const markerFont = getComputedStyle(root().querySelector('[data-merge-conflict-marker-row]')).fontFamily;
                    const codeFont = getComputedStyle(root().querySelector('[data-line]')).fontFamily;
                    if (markerFont == codeFont || /monospace|Consolas|Cascadia/.test(markerFont)) throw new Error('Conflict headings look like code: ' + markerFont);
                    if (markerLabels.some(label => /Updated stack|Replayed commit/.test(label))) throw new Error('Internal marker labels remain visible');
                    if (!row('file.txt').querySelector('.merge-sides').textContent.includes('topic change')) throw new Error('Source commit context missing');
                    if (button('Edit result', column) || button('Save changes', column) || root().querySelector('[contenteditable="true"]')) throw new Error('Custom editing UI remains');
                    const listed = await window.laneway.conflictOperation('fixture', { action: 'list' });
                    if (!listed.ok) throw new Error(listed.error.message);
                    const subject = listed.result.conflicts.find(conflict => conflict.kind == 'commit').id;
                    const savedFile = async () => {
                        const response = await window.laneway.conflictOperation('fixture', { action: 'inspect', subject });
                        if (!response.ok) throw new Error(response.error.message);
                        return response.result.view.files.find(file => file.path == 'file.txt');
                    };
                    for (const choice of ['current', 'both']) {
                        const control = await wait(() => root()?.querySelector('[data-merge-conflict-action="' + choice + '"]'));
                        control.click();
                        await wait(() => row('file.txt').dataset.resolved == 'true' && column.getAttribute('aria-busy') == 'false');
                        const file = await savedFile();
                        const expected = choice == 'current' ? file.leftText : 'Order summary\\nDelivery: three business days.\\nDelivery: next business day.\\nTracking is included.\\n';
                        if (file.resultText != expected) throw new Error('Pierre choice was not saved: ' + choice);
                        if (button('Accept resolution', column)) throw new Error('Partial resolution can be accepted');
                        button('Discard progress', column).click();
                        await wait(() => row('file.txt').dataset.resolved == 'false' && root()?.querySelector('[data-merge-conflict-action="incoming"]'));
                    }
                    const incoming = root().querySelector('[data-merge-conflict-action="incoming"]');
                    const duplicate = root().querySelector('[data-merge-conflict-action="both"]');
                    incoming.click();
                    duplicate.click();
                    await wait(() => row('file.txt').dataset.resolved == 'true' && column.getAttribute('aria-busy') == 'false');
                    const file = await savedFile();
                    if (file.resultText != file.rightText) throw new Error('Incoming choice was not saved or duplicate click overwrote it');
                    const diff = await wait(() => row('file.txt').querySelector('.pierre-diff')?.shadowRoot);
                    await wait(() => diff.textContent.includes('Delivery: next business day.'));
                    if (diff.querySelector('[contenteditable="true"]')) throw new Error('Resolved review is editable');
                    review().click();
                    await wait(() => !row('file.txt').querySelector('.pierre-diff'));
                    review().click();
                    await wait(() => row('file.txt').querySelector('.pierre-diff')?.shadowRoot?.textContent.includes('Delivery: next business day.'));
                    button('Use version before this commit', row('payment.txt')).click();
                    await wait(() => row('payment.txt').dataset.resolved == 'true' && button('Merge tool', row('contact.ts')));
                    if (button('Accept resolution', column)) throw new Error('Unresolved files can be accepted');
                    button('Merge tool', row('contact.ts')).click();
                    await wait(() => button('Accept resolution', column));
                    if (files.querySelectorAll('[data-resolved="true"]').length != 3) throw new Error('Resolved files did not stay in the list');
                    row('contact.ts').querySelector('button[title="contact.ts"]').click();
                    const codeRoot = await wait(() => row('contact.ts').querySelector('.pierre-diff')?.shadowRoot);
                    await wait(() => codeRoot.textContent.includes('live chat'));
                    column.querySelector('.resolution-footer').scrollIntoView({ block: 'nearest' });
                    const bounds = column.getBoundingClientRect();
                    if (bounds.width < 350 || bounds.height < 200) throw new Error('Resolution column did not lay out');
                    const state = await window.laneway.getState();
                    await window.laneway.updateWorkspace(state.workspace);
                    if (violations.length) throw new Error('CSP: ' + violations.join(','));
                    return { candidate: true };
                }
                const lower = await wait(() => document.querySelector('.stack-heading [aria-label="lower has unresolved conflicts"]'));
                lower.closest('button').click();
                const indicator = await wait(() => document.querySelector('[aria-label="Resolve conflicts in topic change"]'));
                indicator.click();
                const column = await wait(() => document.querySelector('[aria-label="Conflict resolution"]'));
                const accept = await wait(() => button('Accept resolution', column));
                if (column.querySelectorAll('.conflict-file[data-resolved="true"]').length != 3) throw new Error('File resolution progress did not survive restart');
                accept.click();
                await wait(() => !document.querySelector('[aria-label="Conflict resolution"]') && !document.querySelector('[aria-label="Unresolved conflicts"]'));
                await wait(() => !document.querySelector('.stack-conflict-indicator'));
                if (violations.length) throw new Error('CSP: ' + violations.join(','));
                return { accepted: true };
            })()`)
            if (phase == 'unresolved') {
                if (conflictReads.filter(read => read.channel == 'conflict:content').length != 1) throw new Error('Expected one direct conflict blob read');
                if (conflictReads.some(read => read.request?.action == 'inspect' && read.request.files?.length != 0)) throw new Error('File expansion requested a full conflict inspection');
            }
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ ...result, conflictReads }))
            clearTimeout(deadline)
            if (phase != "accept") {
                writeFileSync(join(directory, `${phase}.png`), (await window.webContents.capturePage()).toPNG())
                await window.webContents.executeJavaScript(`(async () => {
                    document.querySelector('button[aria-label="Switch to dark appearance"]').click();
                    for (let i = 0; i < 100; i++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const column = document.querySelector('.resolution-footer');
                        if (document.documentElement.dataset.appearance == 'dark' && (await window.laneway.getState()).appearance == 'dark') return;
                    }
                    throw new Error('Conflict column did not adopt dark appearance');
                })()`)
                writeFileSync(join(directory, `${phase}-dark.png`), (await window.webContents.capturePage()).toPNG())
            }
            let violations = await window.webContents.executeJavaScript('window.cspViolations');
            if (violations.length) throw new Error('CSP: ' + violations.join(','));
            app.exit(0)
        } catch (error) {
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: String(error.stack || error) }))
            app.exit(1)
        }
    })
})
import(pathToFileURL(productionMain).href)
