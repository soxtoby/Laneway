# Pierre 1.6.1 and Electron CSP

Laneway keeps its strict renderer CSP. Pierre's native `UnresolvedFile` (built on `FileDiff`) otherwise inserts inline style tags and HTML style attributes that Electron rejects.

`@pierre%2Fdiffs@1.6.1.patch` renders diff HAST through DOM/CSSOM APIs and uses adopted stylesheets for themes. Bun applies it through `patchedDependencies`; no CSP exception is required. Merge behavior and controls come from Pierre unchanged.

When upgrading Pierre, recheck whether the patch is still needed. Run `bun run build`, then `bun test desktop/test/react-conflict-electron.test.ts` against the rebuilt engine and renderer. That test exercises native merge choices, saved progress, external tools, restart, acceptance, and light/dark rendering while checking CSP violations.

# React Aria 3.53.1 and ResizeObserver loops

A file list scrolls with its column, so React Aria's scroll view sizes it by its own content. `react-aria@3.53.1.patch` has the scroll view measure a resized list on the next animation frame rather than inside its ResizeObserver callback: measuring there lays the rows out again at once, which resizes the observed list within the loop that was notifying it, and the browser reports "ResizeObserver loop completed with undelivered notifications", which Bun's development server shows as a frontend error.

When upgrading React Aria, recheck whether `useScrollView`'s `onResize` still calls `updateSize` directly. `bun test desktop/test/react-file-tree-electron.test.ts` narrows a file list in a real window and fails on any window error.
