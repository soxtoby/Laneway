# Laneway agent guide

Read `GLOSSARY.md` for product terminology and settled contracts.

## Renderer

The renderer is a client-only Electron page. Main/preload own privileged work; renderer code uses typed `window.laneway` IPC. Preserve strict CSP and organize renderer modules by functionality.

It is React with React Aria Components, styled by React Aria's starter kit ([ADR 0021](docs/adr/0021-use-react-aria-components-for-the-electron-renderer.md)). For any renderer work, read [the renderer conventions](docs/renderer.md).
