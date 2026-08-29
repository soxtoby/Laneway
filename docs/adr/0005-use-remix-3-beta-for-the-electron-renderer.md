# Use Remix 3 beta for the Electron renderer

Replace the imperative renderer with the `remix@next` Remix 3 beta, not React Router 7 or React. Run it as a client-only, single-route renderer inside Electron, retain the typed preload boundary and strict CSP, and track the `next` channel through the lockfile. Security or Electron-build incompatibility blocks the migration rather than weakening the boundary or silently substituting another framework.

Prove development, production `file://`, CSP, and preload compatibility before replacing the repository-entry journey as one vertical migration. Main/preload remain authoritative for repository and settings state; a renderer controller owns transient view and operation state. Use focused DOM tests plus real-window inspection, preserve visual behavior without preserving exact markup, and remove the browser-only renderer rather than maintaining two implementations.
