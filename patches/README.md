# Pierre 1.6.1 and Electron CSP

Laneway keeps its strict renderer CSP. Pierre's native `UnresolvedFile` (built on `FileDiff`) otherwise inserts inline style tags and HTML style attributes that Electron rejects.

`@pierre%2Fdiffs@1.6.1.patch` renders diff HAST through DOM/CSSOM APIs and uses adopted stylesheets for themes. Bun applies it through `patchedDependencies`; no CSP exception is required. Merge behavior and controls come from Pierre unchanged.

When upgrading Pierre, recheck whether the patch is still needed. Run `bun run build`, then `bun test desktop/test/react-conflict-electron.test.ts` against the rebuilt engine and renderer. That test exercises native merge choices, saved progress, external tools, restart, acceptance, and light/dark rendering while checking CSP violations.
