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
                const commitRow = '.commit-trail .commit-row';
                const repositoryRow = '[aria-label="Open repositories"] [role=row]';
                const colors = () => ({
                    body: background('body'),
                    header: background('header'),
                    panel: background('.repository-panel'),
                    // Disabled accent buttons keep the kit's grey.
                    accent: background('.button-base[data-variant="accent"]:not([data-disabled])'),
                });

                await wait(() => document.querySelector(fileRow) && document.querySelector(commitRow), 'the column');
                await wait(() => document.querySelector('.button-base[data-variant="accent"]:not([data-disabled])'), 'an enabled accent button');
                await wait(() => document.getAnimations().length == 0, 'the enabled button to settle');
                const light = colors();
                const geometry = { header: height('header'), fileRow: height(fileRow), commitRow: height(commitRow), collapsedRepositoryRow: height(repositoryRow) };
                // Long commit subjects and stash messages ellipsize instead of widening the column's content.
                const columnBody = document.querySelector('.column-body');
                await wait(() => document.querySelector('.branch-stash'), 'the stash');
                const fits = { column: columnBody.scrollWidth <= columnBody.clientWidth };
                // A long folder gives way, leaving the file's name whole.
                const deep = [...document.querySelectorAll(fileRow)].find(row => row.textContent.includes('named-file.txt'));
                const name = deep.querySelector('.file-name'), folder = deep.querySelector('.file-directory');
                fits.fileName = name.scrollWidth <= name.clientWidth && folder.scrollWidth > folder.clientWidth;
                // Opening the panel leaves its rows where they were.
                const rowTop = document.querySelector(repositoryRow).getBoundingClientRect().top;
                document.querySelector('button[aria-label="Expand repository sidebar"]').click();
                await wait(() => document.querySelector('button[aria-label="Collapse repository sidebar"]'), 'the expanded panel');
                await wait(() => document.getAnimations().length == 0, 'the panel to open');
                geometry.repositoryRow = height(repositoryRow);
                fits.panelRowsSteady = document.querySelector(repositoryRow).getBoundingClientRect().top == rowTop;

                const row = document.querySelector(fileRow);
                const rect = row.getBoundingClientRect();
                row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.x + 20, clientY: rect.y + 10 }));
                const menu = await wait(() => document.querySelector('[role=menu]'), 'the context menu');
                await wait(() => document.getAnimations().length == 0, 'the menu to settle');
                const menuRect = menu.getBoundingClientRect();
                const contextMenu = { items: [...menu.querySelectorAll('[role=menuitem]')].map(item => item.textContent), atPointer: Math.abs(menuRect.x - rect.x - 20) <= 1 && Math.abs(menuRect.y - rect.y - 10) <= 1 };
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                await wait(() => !document.querySelector('[role=menu]'), 'the context menu to close');

                // Commit stays grey, not amber, until the commit has a title.
                const compose = await wait(() => [...document.querySelectorAll('.commit-split button')].find(button => button.textContent == 'Commit…' && !button.disabled), 'the commit preview');
                compose.click();
                const commit = await wait(() => [...document.querySelectorAll('[aria-label="Working Changes"] button')].find(button => button.textContent.startsWith('Commit all changes')), 'the commit form');
                await wait(() => document.getAnimations().length == 0, 'the form to settle');
                const [red, green, blue] = hex(getComputedStyle(commit).backgroundColor).slice(1).match(/../g).map(channel => parseInt(channel, 16));
                const disabledCommit = { disabled: commit.disabled, grey: Math.max(red, green, blue) - Math.min(red, green, blue) <= 8 };
                [...document.querySelectorAll('[aria-label="Working Changes"] button')].find(button => button.textContent == 'Cancel').click();
                await wait(() => !document.querySelector('[aria-label="Commit title"]'), 'the commit form to close');

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

                // The diff column joins its source column's card across a seam, with the header band running on.
                document.querySelector(fileRow + ' .file-path').click();
                const breakOut = await wait(() => document.querySelector('.column .pierre-diff') && document.querySelector('[aria-label="Break out diff"]'), 'the inline diff');
                // An inline diff's long lines scroll within it.
                fits.inlineDiff = columnBody.scrollWidth <= columnBody.clientWidth;
                // Its pinned scrollbar takes room, where the window's overlay scrollbar would have none, and with the
                // diff running past the column it sits on the column's bottom edge, with no lines showing beneath it.
                const scrollbar = await wait(() => document.querySelector('.column .diff-scrollbar:not([hidden])'), 'the inline diff scrollbar');
                const diffBody = scrollbar.closest('.column-body');
                diffBody.scrollTop += scrollbar.parentElement.querySelector('.pierre-diff').getBoundingClientRect().top - diffBody.getBoundingClientRect().top;
                await new Promise(resolve => requestAnimationFrame(resolve));
                const bodyBottom = diffBody.getBoundingClientRect().top + diffBody.clientTop + diffBody.clientHeight;
                const diffScrollbar = {
                    takesRoom: scrollbar.offsetHeight - scrollbar.clientHeight >= 8,
                    onColumnEdge: Math.abs(scrollbar.getBoundingClientRect().bottom - bodyBottom) <= 0.5,
                };
                diffBody.scrollTop = 0;
                breakOut.click();
                const aside = await wait(() => document.querySelector('.diff-column .pierre-diff') && document.querySelector('.diff-column'), 'the diff column');
                await wait(() => document.getAnimations().length == 0, 'the diff column to settle');
                const seam = aside.previousElementSibling;
                const source = seam.previousElementSibling;
                const diffColumn = {
                    joined: getComputedStyle(source).borderTopRightRadius == '0px' && getComputedStyle(aside).borderTopLeftRadius == '0px'
                        && seam.matches('.column-divider.attached') && Math.abs(aside.getBoundingClientRect().left - seam.getBoundingClientRect().right) <= 0.5,
                    headersAligned: Math.abs(aside.querySelector('header').getBoundingClientRect().height - source.querySelector('header').getBoundingClientRect().height) <= 1,
                    focused: document.activeElement == aside,
                    width: Math.round(aside.getBoundingClientRect().width),
                };
                // Maximized, the source column keeps its width and the diff column takes the rest of the row's view,
                // which scrolls to show them.
                aside.querySelector('[aria-label="Maximize column"]').click();
                const maximized = await wait(() => document.querySelector('.column-group.maximized'), 'the maximized column');
                const columnRow = maximized.parentElement;
                const rowStart = columnRow.getBoundingClientRect().left + parseFloat(getComputedStyle(columnRow).paddingLeft);
                const rowEnd = columnRow.getBoundingClientRect().right - parseFloat(getComputedStyle(columnRow).paddingRight);
                await wait(() => Math.abs(maximized.getBoundingClientRect().left - rowStart) <= 1, 'the maximized column to scroll into view');
                diffColumn.split = Math.abs(aside.getBoundingClientRect().right - rowEnd) <= 1 && Math.round(source.getBoundingClientRect().width) == 380;
                aside.querySelector('[aria-label="Restore column"]').click();
                (await wait(() => document.querySelector('[aria-label="Close diff column"]'), 'the restored columns')).click();
                await wait(() => !document.querySelector('.diff-column'), 'the diff column to close');

                document.querySelector('header button[aria-label="Switch to dark appearance"]').click();
                await wait(() => matchMedia('(prefers-color-scheme: dark)').matches && document.querySelector('header button[aria-label="Switch to light appearance"]'), 'the dark appearance');
                await wait(() => document.getAnimations().length == 0, 'the appearance transitions');
                const dark = colors();

                return { light, dark, geometry, fits, diffScrollbar, contextMenu, disabledCommit, settingsDialog, diffColumn, styleElements: document.querySelectorAll('style').length };
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
