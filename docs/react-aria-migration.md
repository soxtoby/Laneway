# React Aria migration

Plan for [ADR-0021](adr/0021-use-react-aria-components-for-the-electron-renderer.md), agreed on 2026-10-17. Tick a step when it lands.

## Approach

The migration lives on the `react-aria` branch, each step as its own commits, and merges into master once, after step 9, so master goes straight from Remix to React. Master stays on Remix and keeps taking fixes and features.

- **Rebase** the branch onto master as master moves. Changes to screens the branch hasn't reached come across and are ported with their screen; a change to a screen already ported (a ticked step) has to be ported again.
- **Remix screens** change only on master; on the branch they arrive by rebase.
- **`bun.lock`** conflicts resolve by merging `package.json` and running `bun install`. The branch pins `remix`, so this doesn't upgrade it.
- **Side by side:** on the branch, the React renderer is a separate page selected by `LANEWAY_RENDERER=react`, so each ported screen can be compared with its Remix version in a real window. Remix stays the default until step 9 removes it and the switch.

Port each screen with the same recipe:

1. Extract its controller into a framework-free module that exposes `subscribe` and a snapshot; React views read it with `useSyncExternalStore`. Existing framework-free modules (`branch-graph-layout.ts`, `auxiliary-columns.ts`, `discard.ts`, `file-paths.ts`, `lucide-catalog.ts`, `repository-icon-images.ts`, and similar) carry over unchanged.
2. Build the view from the kit's components. Where the kit has no component at Laneway's density or with the behaviour needed, build one from React Aria Components with CSS that uses only the theme's variables (see the conventions below).
3. Port the screen's `renderer.test.ts` cases to React DOM tests on the same `renderer-fixtures.ts` fakes. Query roles and labels rather than markup, which is not preserved.
4. Compare the screen in a real window with the Remix version, in light and dark.

A step is done when its listed tests pass against the React renderer and the screen matches Remix behaviour in the real window.

## Conventions settled by the spike

- **The kit:** React Aria's vanilla CSS starter components live in `ui/`, copied from adobe/react-spectrum at `d3b2bd2` (Apache 2.0). Its README lists every local change; fix kit bugs there and add them to the list, so upstream updates can be compared against the pinned commit.
- **Colours:** set only in Laneway's theme file, which overrides the kit's variables under `:root:root`. `--tint` is Laneway's amber, and accent fills take dark ink. The repository panel stays dark in both appearances by redefining those variables on the panel. Laneway's own CSS uses the variables, never literal colours.
- **Appearance:** the main process sets Electron's `nativeTheme.themeSource` from the appearance setting, so the kit's `prefers-color-scheme` rules follow it without edits.
- **CSP:** plain stylesheets only. `meta#react-aria-pressable-style` with its rule in the page CSS stops React Aria's one inline style, and only the dev server gets a style nonce. Keep `style-src 'self'` and `script-src 'self'` unchanged.
- **Density:** commit rows are 32px, file rows 28px, repository rows 40px (36px collapsed) with 28px tiles. Dense collections are React Aria GridLists sharing one row style; the kit's GridList is a card grid.
- **Row menus:** right-click and Shift+F10 use `MenuTrigger trigger="contextMenu"` around a Pressable that continues propagation, so clicks still select; the same items appear in a hover menu button.
- **Destructive actions** apply immediately with an Undo toast (the kit's toast with an `action`), never a confirmation dialog.
- **Icons** are Lucide nodes (ADR-0020), drawn by `lucideIcon()`, which also gives the kit the `lucide-<name>` classes its CSS expects.

## Steps

- [ ] **0. Foundation.**
  - **Shell and switch:** promote the spike (`spike.html`, `src/spike/`, and the kit in `src/spike/ui/`) to a permanent page and folders, selected by `LANEWAY_RENDERER=react`.
  - **Shared pieces:**
    - Turn the spike's `data.ts` into the first controller.
    - Settle one dense row and context-menu component, with the dev warning about the Pressable child's role resolved.
    - Move notices and the fatal error (`feedback.tsx`) to the kit's toast and an inline alert.
    - Take appearance from settings, including the title bar overlay colours in `main/window.ts`.
  - **Tooling:**
    - A React DOM test harness on happy-dom.
    - An Electron test that drives the React page under the production CSP, the counterpart of `renderer-styles.test.ts`.
    - React Fast Refresh with a dev-only script nonce.
    - `eslint-plugin-react-hooks`, and a stylelint rule that allows colours only in the theme file.
- [ ] **1. Repository entry.**
  - **Scope:** Welcome, open, clone, and initialize with progress and cancellation; Git settings; the fatal bootstrap state.
  - **Remix modules:** `workspace.tsx`, `repository-entry/`, `settings.tsx`.
  - **Tests to port:** the "repository entry renderer" block (initialize, Git settings, clone cancellation, clipboard source, appearance, fatal state).
- [ ] **2. Repository panel.**
  - **Scope:** the side panel with drag-to-reorder (built in the spike), closing, adding, locating a missing repository, and the name and icon editor.
  - **Remix modules:** `repository-rail.tsx`, `repository-icon.tsx`, `repository-identity.tsx`.
  - **Tests to port:** customizing a repository, the inferred favicon, dragging a repository along the rail.
- [ ] **3. Workspace Columns.**
  - **Scope:** layout and persistence, column tabs, resizing, maximizing, collapsing, the auxiliary-column lifecycle, and missing-worktree and recovery columns.
  - **Remix modules:** the shell in `app.tsx`, `branch-workspace/branch-columns.tsx`, `column-divider.tsx`, `worktrees/worktree-columns.ts`, `worktrees/missing-worktree.tsx`, `worktrees/worktree-recovery.tsx`.
  - **Tests to port:** restoring and persisting Workspace Columns, maximizing, retained collapse, recovery columns, missing worktrees.
- [ ] **4. Working Changes and committing.**
  - **Scope:** file list layouts, grouping, and folding; discard with Undo; copying paths; mousedown activation; the commit composer and composition.
  - **Remix modules:** `inspection/file-list.tsx`, `inspection/file-list-view.tsx`, `mouse-activation.ts`, `commit-composer.tsx`, `composition.tsx`, `inspection/commit-message.tsx`.
  - **Tests to port:** the view menu, copying paths, discarding, the commit composer, mousedown activation, and the Electron test `local-electron.test.ts`.
- [ ] **5. Commit Trail and local operations.**
  - **Scope:**
    - Commits, rewording, and Create branch here.
    - Renaming branches and worktrees inline.
    - Creating, switching, and removing worktrees from their previews.
    - Stashes, undo, and redo.
  - **Remix modules:** `trail-commit.tsx`, `reword.tsx`, `editable-name.tsx`, `overflow-menu.tsx`, `context-menu.tsx`, `branch-workspace/local-branch-actions.tsx`, `worktrees/worktree-controls.tsx`, `worktrees/worktree-actions.tsx`.
  - **Tests to port:** rewording, Create branch here, the worktree creation preview, inline renames, detached worktrees, branch deletion.
- [ ] **6. Inspection.**
  - **Scope:**
    - Diff columns: combined and split views, selection, hidden-line gaps, and virtualized large patches.
    - Image diffs.
    - File History, Commit Diff, and breakout columns.
    - Branch Comparison.
  - **Remix modules:** `inspection/`.
  - **Tests to port:**
    - The "Working Changes inspection" and "Branch Comparison" blocks, the File History tests, and the diff column placement and resize tests.
    - The Electron test `image-diff-electron.test.ts`.
- [ ] **7. Branch Graph and Command Lens.**
  - **Scope:**
    - The virtualized graph and its settings.
    - Opening and filtering branches.
    - Rebasing by drag and drop or keyboard.
    - The Command Lens.
  - **Remix modules:** the rest of `branch-workspace/` (graph view, settings, marker details, rebase) and `command-lens.tsx`.
  - **Tests to port:** graph selection and Lens navigation, virtualization, quiet refreshes, Branch Graph settings, the "Branch Graph rebase" block.
- [ ] **8. Pull latest and conflicts.**
  - **Scope:** Pull latest progress, cancellation, and outcomes; confirmation notices; conflict and merge resolution.
  - **Remix modules:** `pull-latest.tsx`, `conflict-resolution.tsx`, `conflict-content.tsx`, `merge-resolution.tsx`.
  - **Tests to port:** the Pull latest tests, notices, `conflict-electron.test.ts`.
- [ ] **9. Cutover.**
  - **Remove Remix:**
    - Delete the Remix renderer, `styles.css`, and the `remix` dependency and its pin.
    - Delete the renderer switch and `renderer-styles.test.ts`.
    - Delete AGENTS.md's Remix section.
  - **Settle the code:** set `jsxImportSource` to `react` in `tsconfig.json` and drop the per-file pragmas.
  - **Merge:** rebase onto master a final time, run the full suite, and merge the branch.

## Open questions

- **Greys:** the kit's greys are neutral, while the dark panel keeps the Remix rail's cool slate. If the mix looks off, tinting the kit's `--gray` is one variable.
- **Commit prototype:** the commit prototype (`commit-prototype*.tsx`, `bun run prototype:commits`) is Remix; port it or delete it before cutover.
