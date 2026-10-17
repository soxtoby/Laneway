# Laneway agent guide

Read `GLOSSARY.md` for product terminology and settled contracts.

## Renderer

The renderer is a client-only Electron page. Main/preload own privileged work; renderer code uses typed `window.laneway` IPC. Preserve strict CSP and organize renderer modules by functionality.

It is migrating from Remix 3 to React Aria Components styled by React Aria's starter kit ([ADR 0021](docs/adr/0021-use-react-aria-components-for-the-electron-renderer.md)). For any renderer work, read [the migration plan](docs/react-aria-migration.md): it records the branch workflow, which screens have moved, the porting recipe, and the styling conventions. Build UI in the React renderer; Remix screens change on master and arrive here by rebase.

## Remix screens

For bug fixes in screens still on Remix, read [the Remix skill](.agents/skills/remix/SKILL.md) and only its relevant references. Remix code uses `remix/ui`, mounted with `createRoot`.

The upstream skill describes a full-stack web app. Its server-first workflow, route layout, hydration, server/HMR setup, and test-runner defaults do not apply here. Use the existing electron-vite setup, Bun tests, and package scripts. Installed Remix documentation lives under `desktop/node_modules/remix/src/`.
