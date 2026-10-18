# React Aria migration

Plan for [ADR-0021](adr/0021-use-react-aria-components-for-the-electron-renderer.md), agreed on 2026-10-17. Tick a step when it lands.

## Approach

The migration lives on the `react-aria` branch, each step as its own commits, and merges into master once, after step 9, so master goes straight from Remix to React. Master stays on Remix and keeps taking fixes and features.

- **Rebase** the branch onto master as master moves. Changes to screens the branch hasn't reached come across and are ported with their screen; a change to a screen already ported (a ticked step) has to be ported again.
- **Remix screens** change only on master; on the branch they arrive by rebase.
- **`bun.lock`** conflicts resolve by merging `package.json` and running `bun install`. The branch pins `remix`, so this doesn't upgrade it.
- **Side by side:** on the branch, the React renderer is a separate page selected by `LANEWAY_RENDERER=react`, so each ported screen can be compared with its Remix version in a real window. Remix stays the default until step 9 removes it and the switch.

Port each screen with the same recipe:

1. Extract its controller into a framework-free module that exposes `subscribe` and a snapshot, as `app-controller.ts` does; React views read it with `useSnapshot`. Existing framework-free modules (`branch-graph-layout.ts`, `auxiliary-columns.ts`, `discard.ts`, `file-paths.ts`, `lucide-catalog.ts`, `repository-icon-images.ts`, and similar) carry over unchanged.
2. Build the view from the kit's components. Where the kit has no component at Laneway's density or with the behaviour needed, build one from React Aria Components with CSS that uses only the theme's variables (see the conventions below).
3. Port the screen's `renderer.test.ts` cases to React DOM tests on the same `renderer-fixtures.ts` fakes, as `react-app.test.tsx` does. Query roles and labels rather than markup, which is not preserved. Extend `react-renderer-styles.test.ts` for what only a real window shows: layout, colours, and the CSP.
4. Compare the screen in a real window with the Remix version, in light and dark.

A step is done when its listed tests pass against the React renderer and the screen matches Remix behaviour in the real window.

## Conventions

- **The kit:** React Aria's vanilla CSS starter components live in `react/ui/`, copied from adobe/react-spectrum at `d3b2bd2` (Apache 2.0). Its README lists every local change; fix kit bugs there and add them to the list, so upstream updates can be compared against the pinned commit.
- **Colours:** set only in Laneway's theme file, `react/theme.css`, which overrides the kit's variables under `:root:root`. `--tint` is Laneway's amber, and accent fills take dark ink. The repository panel stays dark in both appearances by redefining those variables on the panel. Laneway's own CSS uses the variables, never literal colours; `bun run lint` checks this with stylelint. The kit's own stylesheets keep their upstream colours.
- **Appearance:** the main process sets Electron's `nativeTheme.themeSource` from the appearance setting, so the kit's `prefers-color-scheme` rules follow it without edits. The window's background and title bar overlay can't read the stylesheets, so `main/window-colors.ts` repeats the header's colours, and `react-renderer-styles.test.ts` checks that they still match.
- **CSP:** plain stylesheets only. `meta#react-aria-pressable-style` with its rule in the page CSS stops React Aria's one inline style. Only the dev server gets a nonce, for Vite's style tags and Fast Refresh's preamble script. Keep `style-src 'self'` and `script-src 'self'` unchanged.
- **Density:** commit rows are 32px, file rows 28px, repository rows 40px (36px collapsed) with 28px tiles. Dense collections are React Aria GridLists of `DenseRow`s sharing one row style; the kit's GridList is a card grid.
- **Activation:** React Aria's own press timing replaces the Remix renderer's mousedown activation (`mouse-activation.ts`): collection items select and menus open on pointer down, and buttons act on release, which leaves native drags free to start from any row.
- **Row menus:** a `DenseRow` takes its menu items once. Right-click opens them at the pointer, and Shift+F10 under the row, through the app's one `ContextMenuHost`; the same items appear in the row's hover menu button. The host sits outside every list, because a menu rendered inside a row passes its focus events to the list through React's portal bubbling.
- **Dialogs** are the kit's `Modal` and `Dialog`, open while their controller says so. Escape and Cancel go through the controller, which can keep a dialog open while Git runs. Forms use the kit's `Form` and `TextField`, and a failure shows in the form as an alert that takes focus.
- **Tests:** React DOM tests install Happy DOM with `installReactDom` from `test/react-dom.ts` before importing views. React Aria acts on pointer presses, so tests press with pointer events rather than `click()`.
- **Destructive actions** apply immediately with an Undo toast (the kit's toast with an `action`), never a confirmation dialog.
- **Icons** are Lucide nodes (ADR-0020), drawn by `lucideIcon()`, which also gives the kit the `lucide-<name>` classes its CSS expects.

## Steps

- [x] **0. Foundation.**
  - **Shell and switch:** the React page is `react.html` with its modules in `src/renderer/react/`, selected by `LANEWAY_RENDERER=react`; `bun run dev:react` serves it.
  - **Shared pieces:**
    - `app-controller.ts` owns startup, appearance, the open repositories, and notices. Until step 3, it also reads the spike's column preview (`column-preview.ts`).
    - `DenseRow` and `ContextMenuHost` are the dense row and its context menu.
    - Notices show as the kit's toast, and a failed start as an inline alert with Retry (`notices.tsx`, `startup.tsx`).
    - The appearance setting drives the native theme, the window background, and the title bar overlay (`main/window-colors.ts`).
  - **Tooling:**
    - React DOM tests on Happy DOM (`test/react-dom.ts`).
    - `react-renderer-styles.test.ts` drives the built React page under the production CSP in both appearances.
    - React Fast Refresh with a dev-only script nonce.
    - `eslint-plugin-react-hooks` and ESLint for the React renderer's `.tsx`, and stylelint's colour rule.
- [x] **1. Repository entry.**
  - **Scope:** Welcome, open, clone, and initialize with progress and cancellation; Git settings; the fatal bootstrap state and the Workspace State recovery banner.
  - **Remix modules:** `workspace.tsx`, `repository-entry/`, `settings.tsx`.
  - **Tests ported:** the "repository entry renderer" block, to `react-app.test.tsx`. The controllers, `repository-entry.ts` and `git-settings.ts`, have their own tests in `react-repository-entry.test.ts`.
- [x] **2. Repository panel.**
  - **Scope:** the side panel with drag-to-reorder (built in the spike), closing, adding, locating a missing repository, and the name and icon editor.
  - **Remix modules:** `repository-rail.tsx`, `repository-icon.tsx`, `repository-identity.tsx`.
  - **Tests ported:** customizing a repository, the inferred favicon, and reordering, to `react-repository-panel.test.tsx`. React Aria's drag and drop replaces the Remix rail's own pointer drag: rows show a drop line instead of stepping aside, and the drag handle adds keyboard drag, so the test drags by keyboard; mouse drags were checked in a real window.
- [x] **3. Workspace Columns.**
  - **Scope:** layout and persistence, column tabs, resizing, maximizing, collapsing, reordering by keyboard or header drag, and recovery columns. `branch-workspace.ts` reads the Branch Graph and owns the columns; until steps 4 and 5, column bodies still show the spike's Working Changes and commits (`column-body.tsx`).
  - **Remix modules:** the shell in `app.tsx`, `branch-workspace/branch-columns.tsx`, `column-divider.tsx`, `worktrees/worktree-columns.ts`, `worktrees/worktree-recovery.tsx`.
  - **Tests ported:** restoring and persisting Workspace Columns, maximizing, retained collapse, and recovery columns, to `react-workspace-columns.test.tsx`; the controller's own rules are in `react-branch-workspace.test.ts`.
  - **Moved on:** a missing worktree's column shows its panel, but Repair and Remove go through worktree previews, so they and the missing-worktree tests move to step 5. Auxiliary columns are opened by Inspection, so their lifecycle moves to step 6.
- [x] **4. Working Changes and committing.**
  - **Scope:**
    - Working Changes as a card with the staged list above the unstaged one; file list layouts, grouping, folding, and choosing whole files; discard with Undo and Ctrl+Z; copying paths.
    - A branch's stashes above its Working Changes: their files, stashing, applying, and dropping.
    - The commit composer: drafts, Stage all and Unstage all, hook review, and the branch a detached worktree's commit creates, named in place.
    - `inspection.ts` reads each column's files and `commit-composer.ts` commits and stashes a worktree; `editable-name.tsx` is the in-place name editor that step 5's renames reuse.
  - **Remix modules:** `inspection/file-list.tsx`, `inspection/file-list-view.tsx`, `commit-composer.tsx`, `editable-name.tsx`, and the Working Changes part of `inspection/inspection.tsx`; `inspection/discard.ts` carries over.
  - **Tests ported:** the view menu, copying paths, discarding, the commit composer, and the two detached-worktree tests, to `react-working-changes.test.tsx`, with stashes and hook review added there. The draft and commit phases of `local-electron.test.ts` are in `react-local-electron.test.ts`.
  - **Moved on:**
    - Composition moves files between lists, stashes, columns, and commits, and is also how a single file is staged, so it moves to step 5 with the Commit Trail it lands on. So do `local-electron.test.ts`'s compose and branch phases.
    - Line discards, the diff column button, the File history menu item, and showing ignored files belong to diffs and filters, so they move to step 6.
    - Mousedown activation is not ported; see the Activation convention.
- [x] **5. Commit Trail and local operations.**
  - **Scope:**
    - The Commit Trail (`commit-trail.tsx`): the column's branch and the bases below it, paged, with ambiguous bases chosen after the last page; commits that unfold to their message and files, with merge parents to compare; commits and branches the remote already has in the remote tone.
    - Rewording (`reword.ts`), and creating, renaming, and deleting branches (`local-branches.ts`, `local-branch-dialog.tsx`): Create branch here from a commit's menu, F2 and Delete on a branch column, and the column's branch renamed in place.
    - Worktrees (`worktree-actions.ts`, `worktree-controls.tsx`, `worktree-dialog.tsx`): a worktree column's name renames in place over its path; its menu switches branch through a branch search, unlocks, repairs, or removes it; a branch column without a worktree checks the branch out in an existing worktree or a new one; a missing worktree's panel offers Repair and Remove. Each operation is reviewed in a dialog before it runs.
    - Undo and redo from the header and by Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z, after any waiting discard; an undo into a taken directory asks for another name. The header's Stashes dialog applies a stash to a chosen worktree or drops it (`stashes.ts`).
    - Composition (`composition.ts`, `transfer.tsx`): grips on files, folders, commits, and branches drag their rows, or choose them with M or C for the arrow keys and Enter; Working Changes, the staging lists, commits, the seams between commits, and branch headings take them, with the review at the destination. Commit and stash files can be chosen like Working Changes files.
  - **Remix modules:** `reword.tsx`, `composition.tsx`, `inspection/commit-message.tsx`, `branch-workspace/local-branch-actions.tsx`, the Commit Trail part of `inspection/inspection.tsx`, `worktrees/worktree-controls.tsx`, `worktrees/worktree-actions.tsx`, `worktrees/missing-worktree.tsx`. The React renderer's row menus and the kit's menus replace `overflow-menu.tsx` and `context-menu.tsx`.
  - **Tests ported:**
    - `react-commit-trail.test.tsx`: remote commits and branches, unfolding commits, ambiguous bases, Create branch here, rewording, inline renames, and branch deletion.
    - `react-worktrees.test.tsx`: missing worktrees, a missing detached worktree returning, the creation preview, inline worktree renames with branch switching and removal; undo, redo, and the Stashes dialog are new.
    - `react-composition.test.tsx` covers staging by moving files and the keyboard paths; `react-composition-electron.test.ts` ports `composition-browser.test.ts` with real drags under the production CSP.
    - `react-local-electron.test.ts` now has the branch and compose phases of `local-electron.test.ts`.
  - **Moved on:**
    - A conflicting transfer offers only Continue and resolve later until conflict resolution moves in step 8.
    - Branch deletion and worktree removal keep the Remix renderer's confirmation dialogs. Both are undoable, so the Destructive actions convention could replace them with an Undo notice; that is a behaviour change for master first.
- [ ] **6. Inspection.**
  - **Scope:**
    - Diff columns: combined and split views, selection, hidden-line gaps, and virtualized large patches.
    - Discarding selected lines, the Working Changes diff column button, the file filter, and showing ignored files.
    - Image diffs.
    - File History, Commit Diff, and breakout columns, with the auxiliary-column lifecycle (`auxiliary-columns.ts`).
    - Branch Comparison. Until then, saved comparison columns keep their place and show their description.
    - Arrow keys through a column's branches, commits, and files (`inspection/column-navigation.ts`).
  - **Remix modules:** `inspection/` and `trail-commit.tsx`, File History's commit column.
  - **Tests to port:**
    - The "Working Changes inspection" and "Branch Comparison" blocks, the File History tests, the diff column placement and resize tests, and the line discards in the discarding test.
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
  - **Scope:** Pull latest progress, cancellation, and outcomes; confirmation notices; conflict and merge resolution, including Continue and resolve now after a conflicting transfer.
  - **Remix modules:** `pull-latest.tsx`, `conflict-resolution.tsx`, `conflict-content.tsx`, `merge-resolution.tsx`.
  - **Tests to port:** the Pull latest tests, notices, `conflict-electron.test.ts`.
- [ ] **9. Cutover.**
  - **Remove Remix:**
    - Delete the Remix renderer, `styles.css`, and the `remix` dependency and its pin.
    - Delete the renderer switch (`reactRenderer` in `main/window-colors.ts`, `dev:react`) and `renderer-styles.test.ts`; `react.html` becomes the only page.
    - Delete AGENTS.md's Remix section.
  - **Settle the code:**
    - Set `jsxImportSource` to `react` in `tsconfig.json` and drop the per-file pragmas.
    - Lint every `.tsx` and stylesheet; ESLint and stylelint cover only the React renderer until then.
  - **Merge:** rebase onto master a final time, run the full suite, and merge the branch.

## Open questions

- **Greys:** the kit's greys are neutral, while the dark panel keeps the Remix rail's cool slate. If the mix looks off, tinting the kit's `--gray` is one variable.
- **Commit prototype:** the commit prototype (`commit-prototype*.tsx`, `bun run prototype:commits`) is Remix; port it or delete it before cutover.
