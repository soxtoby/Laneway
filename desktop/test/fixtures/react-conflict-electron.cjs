let { app, ipcMain } = require("electron")
let conflictReads = []
let originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
    let started = performance.now()
    let result = await listener(...args)
    if (channel == "conflict:content" || channel == "conflict:operation")
        conflictReads.push({ channel, request: args[2], ms: performance.now() - started })
    return result
})
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")

// Resolves the fixture repository's conflict in the built app's React renderer, one phase per launch;
// react-conflict-electron.test.ts checks the repository between phases.
let [directory, productionMain, phase] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
app.on("browser-window-created", (_event, window) => {
    window.hide()
    // React Aria opens popovers and restores focus on animation frames, which a hidden window would hold.
    window.webContents.setBackgroundThrottling(false)
    let deadline = setTimeout(async () => {
        let body = await window.webContents.executeJavaScript("({ text: document.body.innerText, waiting: window.lastWait, csp: window.cspViolations })").catch(String)
        writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: "Timed out", body }))
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
                const settle = () => wait(() => document.getAnimations().length == 0);
                const column = () => document.querySelector('[aria-label="Conflict resolution"]');
                await wait(() => document.querySelector('.commit-trail'));
                if (${JSON.stringify(phase)} != 'accept') {
                    const toggle = await wait(() => document.querySelector('[aria-label="Show only conflicted commits"]'));
                    const lowerIndicator = await wait(() => document.querySelector('.stack-heading [aria-label="lower has unresolved conflicts"]'));
                    const lowerHeading = lowerIndicator.closest('button');
                    if (lowerHeading.getAttribute('aria-expanded') != 'false') throw new Error('Lower branch should initially be folded');
                    if (document.querySelector('.stack-heading [aria-label="main has unresolved conflicts"]')) throw new Error('Clean base marked conflicted');
                    lowerHeading.click();
                    await wait(() => document.querySelectorAll('.trail-commit').length == 2);
                    if (document.querySelector('[aria-label="Unresolved conflicts"]')) throw new Error('Duplicate conflict list: ' + document.querySelector('[aria-label="Unresolved conflicts"]').textContent);
                    toggle.click();
                    await wait(() => toggle.getAttribute('aria-pressed') == 'true' && document.querySelectorAll('.trail-commit').length == 1);
                    if (!document.querySelector('.trail-commit').textContent.includes('topic change')) throw new Error('Filtered the wrong commit');
                    toggle.click();
                    await wait(() => toggle.getAttribute('aria-pressed') == 'false' && document.querySelectorAll('.trail-commit').length == 2);
                    const indicator = await wait(() => document.querySelector('[aria-label="Resolve conflicts in topic change"]'));
                    if (!indicator.closest('.commit-row')) throw new Error('Conflict indicator is not in its commit row');
                    if (${JSON.stringify(phase)} == 'candidate') indicator.closest('.trail-commit').querySelector('.commit-toggle').click();
                    else indicator.click();
                    const resolution = await wait(column);
                    if (!resolution.closest('.trail-commit')) throw new Error('Resolution is not inline in the commit');
                    await wait(() => resolution.querySelectorAll('.conflict-file').length == 3);
                    const row = path => [...resolution.querySelectorAll('.conflict-file')].find(item => item.dataset.file == path);
                    if (resolution.querySelector('.pierre-merge, .pierre-diff')) throw new Error('A file opened by itself');
                    const commitControl = document.querySelector('.commit-row .icon-button.small').getBoundingClientRect().height;
                    for (const item of resolution.querySelectorAll('.conflict-file')) {
                        if (!button('Use version before this commit', item) || !button('Use this commit', item) || !button('Merge tool', item)) throw new Error('File actions are missing');
                        if (item.querySelector('.conflict-file-row').getBoundingClientRect().height > 30) throw new Error('Conflict file is not a compact row');
                        if (getComputedStyle(item.querySelector('.file-name')).fontFamily.includes('Consolas')) throw new Error('Conflict filenames do not match commit files');
                        for (const control of item.querySelectorAll('.conflict-file-actions > button')) {
                            if (Math.abs(control.getBoundingClientRect().height - commitControl) > 0.5) throw new Error('File action size differs from commit controls');
                        }
                    }
                    // The commit's clean files list below its conflicts, and open their diffs as any commit's do.
                    const clean = await wait(() => [...resolution.querySelectorAll('.file-row')].find(item => item.textContent.includes('notes.txt')));
                    clean.querySelector('.file-path').click();
                    await wait(() => clean.querySelector('.pierre-diff')?.shadowRoot?.textContent.includes('A clean file in the conflicted commit'));
                    clean.querySelector('.file-path').click();
                    await wait(() => !clean.querySelector('.pierre-diff'));
                    // Narrowing the column after its file list has measured keeps each conflict's actions in view.
                    const trail = resolution.closest('.commit-trail');
                    const files = resolution.closest('.commit-files');
                    trail.style.width = Math.round(trail.getBoundingClientRect().width * 0.6) + 'px';
                    // The list measures its new width on an animation frame.
                    for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
                    for (const actions of resolution.querySelectorAll('.conflict-file-actions')) {
                        if (actions.getBoundingClientRect().right > files.getBoundingClientRect().right + 0.5) throw new Error('Conflict file actions overflow a narrowed column');
                    }
                    trail.style.width = '';
                    if (resolution.innerText.includes('<<<<<<<') || resolution.innerText.includes('Replayed commit ') || resolution.innerText.includes('Candidate')) throw new Error('Diagnostic conflict content is visible');
                    button('More actions for contact.ts', row('contact.ts')).click();
                    const menuItem = await wait(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(item => item.textContent == 'Use current file'));
                    await settle();
                    const menuBounds = menuItem.getBoundingClientRect();
                    const hit = document.elementFromPoint(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height / 2);
                    if (!menuItem.contains(hit)) throw new Error('File menu obscured: ' + hit?.outerHTML.slice(0, 300));
                    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                    await wait(() => !document.querySelector('[role=menu]'));
                    const toggleFile = path => button(path, row(path));
                    const merge = () => row('file.txt').querySelector('.pierre-merge')?.shadowRoot?.querySelector('diffs-container')?.shadowRoot;
                    if (${JSON.stringify(phase)} == 'unresolved') {
                        toggleFile('file.txt').click();
                        await wait(() => merge()?.querySelector('[data-line]'));
                        const state = await window.laneway.getState();
                        await window.laneway.updateWorkspace(state.workspace);
                        if (violations.length) throw new Error('CSP: ' + violations.join(','));
                        return { unresolved: true };
                    }
                    toggleFile('file.txt').click();
                    await wait(() => merge()?.querySelector('[data-merge-conflict-action="incoming"]'));
                    const markerLabels = [...merge().querySelectorAll('[data-merge-conflict-marker-row] > span')].map(label => label.textContent);
                    if (!markerLabels.includes('Before this commit') || !markerLabels.includes('This commit')) throw new Error('Conflict sides are not labelled: ' + markerLabels.join(','));
                    for (const [action, kind] of [['current', 'marker-start'], ['incoming', 'marker-end']]) {
                        const control = merge().querySelector('[data-merge-conflict-action="' + action + '"]');
                        if (control.textContent != 'Keep this' || control.parentElement.dataset.mergeConflict != kind) throw new Error('Keep this is not in its side heading: ' + action);
                    }
                    if (merge().querySelector('[data-merge-conflict-action="both"]').textContent != 'Keep both') throw new Error('Keep both missing');
                    // Its long line scrolls under a pinned scrollbar, with each side's Keep this still in view.
                    const host = row('file.txt').querySelector('.pierre-merge');
                    const scrollbar = await wait(() => host.parentElement.querySelector('.diff-scrollbar:not([hidden])'));
                    scrollbar.scrollLeft = 120;
                    await wait(() => merge().querySelector('[data-code]').scrollLeft == 120);
                    for (const control of merge().querySelectorAll('[data-merge-conflict-marker-row] button')) {
                        if (control.getBoundingClientRect().right > host.getBoundingClientRect().right + 0.5) throw new Error('Keep this is out of view');
                    }
                    const markerFont = getComputedStyle(merge().querySelector('[data-merge-conflict-marker-row]')).fontFamily;
                    const codeFont = getComputedStyle(merge().querySelector('[data-line]')).fontFamily;
                    if (markerFont == codeFont || /monospace|Consolas|Cascadia/.test(markerFont)) throw new Error('Conflict headings look like code: ' + markerFont);
                    if (!row('file.txt').querySelector('.merge-sides').textContent.includes('topic change')) throw new Error('Source commit context missing');
                    const listed = await window.laneway.conflictOperation('fixture', { action: 'list' });
                    if (!listed.ok) throw new Error(listed.error.message);
                    const subject = listed.result.conflicts.find(conflict => conflict.kind == 'commit').id;
                    const savedFile = async () => {
                        const response = await window.laneway.conflictOperation('fixture', { action: 'inspect', subject });
                        if (!response.ok) throw new Error(response.error.message);
                        return response.result.view.files.find(file => file.path == 'file.txt');
                    };
                    for (const choice of ['current', 'both']) {
                        const control = await wait(() => merge()?.querySelector('[data-merge-conflict-action="' + choice + '"]'));
                        control.click();
                        await wait(() => row('file.txt').dataset.resolved == 'true' && resolution.getAttribute('aria-busy') == 'false');
                        const file = await savedFile();
                        const expected = choice == 'current' ? file.leftText : file.leftText.replace('Delivery: three business days.\\n', 'Delivery: three business days.\\nDelivery: next business day.\\n');
                        if (file.resultText != expected) throw new Error('Pierre choice was not saved: ' + choice);
                        if (button('Accept resolution', resolution)) throw new Error('A partial resolution can be accepted');
                        button('Discard progress', resolution).click();
                        await wait(() => row('file.txt').dataset.resolved == 'false' && merge()?.querySelector('[data-merge-conflict-action="incoming"]'));
                    }
                    const incoming = merge().querySelector('[data-merge-conflict-action="incoming"]');
                    const duplicate = merge().querySelector('[data-merge-conflict-action="both"]');
                    incoming.click();
                    duplicate.click();
                    await wait(() => row('file.txt').dataset.resolved == 'true' && resolution.getAttribute('aria-busy') == 'false');
                    const file = await savedFile();
                    if (file.resultText != file.rightText) throw new Error('Incoming choice was not saved, or the duplicate click overwrote it');
                    const review = await wait(() => row('file.txt').querySelector('.pierre-diff')?.shadowRoot);
                    await wait(() => review.textContent.includes('Delivery: next business day.'));
                    if (review.querySelector('[contenteditable="true"]')) throw new Error('Resolved review is editable');
                    toggleFile('file.txt').click();
                    await wait(() => !row('file.txt').querySelector('.pierre-diff'));
                    toggleFile('file.txt').click();
                    await wait(() => row('file.txt').querySelector('.pierre-diff')?.shadowRoot?.textContent.includes('Delivery: next business day.'));
                    button('Use version before this commit', row('payment.txt')).click();
                    await wait(() => row('payment.txt').dataset.resolved == 'true' && button('Merge tool', row('contact.ts')));
                    if (button('Accept resolution', resolution)) throw new Error('Unresolved files can be accepted');
                    button('Merge tool', row('contact.ts')).click();
                    await wait(() => button('Accept resolution', resolution));
                    if (resolution.querySelectorAll('[data-resolved="true"]').length != 3) throw new Error('Resolved files did not stay in the list');
                    toggleFile('contact.ts').click();
                    const codeRoot = await wait(() => row('contact.ts').querySelector('.pierre-diff')?.shadowRoot);
                    await wait(() => codeRoot.textContent.includes('live chat'));
                    resolution.querySelector('.resolution-footer').scrollIntoView({ block: 'nearest' });
                    const bounds = resolution.getBoundingClientRect();
                    if (bounds.width < 300 || bounds.height < 200) throw new Error('Resolution did not lay out: ' + JSON.stringify(bounds.toJSON()));
                    const state = await window.laneway.getState();
                    await window.laneway.updateWorkspace(state.workspace);
                    if (violations.length) throw new Error('CSP: ' + violations.join(','));
                    return { candidate: true };
                }
                const lower = await wait(() => document.querySelector('.stack-heading [aria-label="lower has unresolved conflicts"]'));
                lower.closest('button').click();
                const indicator = await wait(() => document.querySelector('[aria-label="Resolve conflicts in topic change"]'));
                indicator.click();
                const resolution = await wait(column);
                const accept = await wait(() => button('Accept resolution', resolution));
                if (resolution.querySelectorAll('.conflict-file[data-resolved="true"]').length != 3) throw new Error('Resolution progress did not survive restart');
                accept.click();
                await wait(() => !column() && !document.querySelector('[aria-label="Unresolved conflicts"]'));
                await wait(() => !document.querySelector('.branch-conflict'));
                if (violations.length) throw new Error('CSP: ' + violations.join(','));
                return { accepted: true };
            })()`)
            if (phase == "unresolved") {
                if (conflictReads.filter(read => read.channel == "conflict:content").length != 1)
                    throw new Error("Expected one direct conflict blob read")
                if (conflictReads.some(read => read.request?.action == "inspect" && read.request.files?.length != 0))
                    throw new Error("File expansion requested a full conflict inspection")
            }
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ ...result, conflictReads }))
            clearTimeout(deadline)
            if (phase != "accept")
                writeFileSync(join(directory, `${phase}.png`), (await window.webContents.capturePage()).toPNG())
            app.exit(0)
        } catch (error) {
            writeFileSync(join(directory, `${phase}.json`), JSON.stringify({ error: String(error.stack || error) }))
            app.exit(1)
        }
    })
})
import(pathToFileURL(productionMain).href)
