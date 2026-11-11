let { app } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let { pathToFileURL } = require("node:url")

// Opens the diff column on the built app's Working Changes, scrolls until the lower file's toolbar pins over its
// lines, and switches its layout to side by side and back, reporting where the line under the toolbar went each time;
// react-diff-layout-electron.test.ts checks the report.
let [directory, productionMain] = process.argv.slice(2)
app.setPath("userData", join(directory, "profile"))
// The diffs draw on animation frames, which a hidden window would hold.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows")
app.commandLine.appendSwitch("disable-renderer-backgrounding")
app.on("browser-window-created", (_event, window) => {
    window.hide()
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
                    throw new Error('Timed out waiting for ' + what + ': ' + document.body.innerText.slice(0, 500));
                };
                const frames = async count => {
                    for (let i = 0; i < count; i++)
                        await new Promise(resolve => requestAnimationFrame(resolve));
                };
                const row = name => document.querySelector('[aria-label="Working Changes"] .file-row[aria-label="' + name + '"]');
                const file = name => [...document.querySelectorAll('.diff-column [data-diff-path]')].find(section => section.dataset.diffPath == name);
                const lines = name => [...(file(name)?.querySelector('.pierre-diff')?.shadowRoot?.querySelectorAll('[data-line][data-line-index]') ?? [])];
                // A line's index is its row in the unified layout, then in the side by side one.
                const half = (line, split) => line.dataset.lineIndex.split(',')[split ? 1 : 0];
                const find = (name, index, split) => lines(name).find(line => half(line, split) == index.split(',')[split ? 1 : 0]);

                // The row of above.ts opens the diff column at the top of its files.
                (await wait(() => row('above.ts'), "the row of above.ts")).querySelector('[aria-label="Open above.ts in diff column"]').click();
                const body = await wait(() => document.querySelector('.diff-column-files'), 'the diff column');
                await wait(() => lines('above.ts').length, "the diff of above.ts");
                // Scrolled as the user scrolls it, the column stops holding the chosen file at its top.
                body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
                // The column draws only the diffs near the view, so it scrolls until it draws that of below.ts.
                for (let i = 0; i < 100 && !lines('below.ts').length; i++) {
                    body.scrollTop += 1000;
                    await frames(2);
                }
                const header = () => file('below.ts').querySelector('.diff-toolbar').getBoundingClientRect();

                // An addition sharing its side by side row with a deletion goes under the pinned toolbar, so switching back
                // has to return to the addition rather than to its row's deletion. A diff draws its lines once it nears
                // the view, after the column scrolls.
                const additions = await wait(() => {
                    const drawn = lines('below.ts').filter(line => line.dataset.lineType == 'change-addition');
                    return drawn.length > 8 && drawn;
                }, 'the additions of below.ts');
                const index = additions[8].dataset.lineIndex;
                const held = () => wait(() => find('below.ts', index, false), 'the held line');
                for (let i = 0; i < 4; i++) {
                    body.scrollTop += (await held()).getBoundingClientRect().top - header().bottom;
                    await frames(4);
                }
                const top = (await held()).getBoundingClientRect().top;

                // Switches the layout from the toolbar of below.ts, and reports how far the line with this index moved.
                const place = async (label, split, index, top) => {
                    file('below.ts').querySelector('[aria-label="' + label + '"]').click();
                    await frames(30);
                    const line = find('below.ts', index, split);
                    return line ? Math.round(line.getBoundingClientRect().top - top) : 'not drawn';
                };
                const pinned = {
                    under: Math.round(top - header().bottom),
                    split: await place('Side by side', true, index, top),
                    unified: await place('Unified', false, index, top),
                };

                // Partway down the view, under the diff of above.ts, the toolbar stays put with its first line.
                body.scrollTop += file('below.ts').getBoundingClientRect().top - body.getBoundingClientRect().top - 300;
                await frames(4);
                const first = await wait(() => lines('below.ts')[0], 'the first line of below.ts');
                const firstIndex = first.dataset.lineIndex;
                const firstTop = first.getBoundingClientRect().top;
                const partway = {
                    split: await place('Side by side', true, firstIndex, firstTop),
                    unified: await place('Unified', false, firstIndex, firstTop),
                };
                return { pinned, partway };
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
