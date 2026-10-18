# React Aria starter components

Copied from React Aria's vanilla CSS starter kit, `starters/docs/src` in [adobe/react-spectrum](https://github.com/adobe/react-spectrum/tree/d3b2bd2fc793b4408490f7da1fe7b25eee2d5640/starters/docs/src) at commit `d3b2bd2`, under the Apache 2.0 licence in `LICENSE`. They are Laneway's own from here; pull upstream changes by comparing against that commit.

Local changes:

- Every `.tsx` starts with `/** @jsxImportSource react */`, because the Remix renderer sets the project's JSX source.
- Icons come from `./icons`, which draws Lucide's node data (ADR 0020) in place of `lucide-react`.
- The per-file `@import` of `theme.css` and `utilities.css` is gone; the page imports each once, before these files.
- `Toast.tsx` takes an optional action, such as Undo, and ignores the rejection when a new toast interrupts a view transition.
- `Button.tsx` accepts an `accent` variant, and wraps text children in a `<span>` so an icon with a label is not styled as an icon-only button.
- `Disclosure.css` pads only the panel's own wrapper (`> div`), not every `div` inside it.
- The `"use client"` directives are gone; this is a client-only renderer.

Laneway's colours and density are set in `../theme.css` by overriding the starter's variables, not by editing `theme.css` here.
