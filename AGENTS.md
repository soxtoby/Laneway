# Laneway agent guide

Read `CONTEXT.md` for product terminology and settled contracts.

## Remix renderer

For Remix UI implementation, refactoring, or review, read [the Remix skill](.agents/skills/remix/SKILL.md) and only its relevant references.

Apply it within [ADR 0005](docs/adr/0005-use-remix-3-beta-for-the-electron-renderer.md): this is a client-only Electron renderer using `remix/ui`, mounted with `createRoot`. Main/preload own privileged work; renderer code uses typed `window.laneway` IPC. Preserve strict CSP and organize renderer modules by functionality.

The upstream skill describes a full-stack web app. Its server-first workflow, route layout, hydration, server/HMR setup, and test-runner defaults do not apply here. Use the existing electron-vite setup, Bun tests, and package scripts. Installed Remix documentation lives under `desktop/node_modules/remix/src/`.
