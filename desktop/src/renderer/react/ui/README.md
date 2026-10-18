# React Aria starter components

Copied from React Aria's vanilla CSS starter kit, `starters/docs/src` in [adobe/react-spectrum](https://github.com/adobe/react-spectrum/tree/d3b2bd2fc793b4408490f7da1fe7b25eee2d5640/starters/docs/src) at commit `d3b2bd2`, under the Apache 2.0 licence in `LICENSE`. They are Laneway's own from here; pull upstream changes by comparing against that commit.

Local changes:

- Icons come from `./icons`, which draws Lucide's node data (ADR 0020) in place of `lucide-react`.
- The per-file `@import` of `theme.css` and `utilities.css` is gone; the page imports each once, before these files.
- `Toast.tsx` takes an optional action, such as Undo, and ignores the rejection when a new toast interrupts a view transition.
- `Button.tsx` accepts an `accent` variant, keeps a `className` passed to it beside its own, and wraps text children in a `<span>` so an icon with a label is not styled as an icon-only button.
- `Disclosure.css` pads only the panel's own wrapper (`> div`), not every `div` inside it.
- The `"use client"` directives are gone; this is a client-only renderer.
- `Modal.css` centres the modal in a fixed overlay. The upstream sticky offset left any modal taller than half the window against its top edge, and Laneway's page never scrolls.
- `ProgressBar.tsx` types its fill's style as `CSSProperties` rather than `any`, for the lint rules.
- `TextField.tsx`'s `TextArea` leaves out its label when it has none, as `TextField` does, so an `aria-label` names it alone.

Laneway's colours and density are set in `../theme.css` by overriding the starter's variables, not by editing `theme.css` here.
