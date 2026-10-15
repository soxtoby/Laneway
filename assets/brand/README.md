# Laneway logo

The Hidden L: an open L-shaped passage cut into a rounded block.

- `laneway.svg`: standalone ink mark; transparent background.
- `laneway-icon.svg`: full-size amber app mark; transparent background.
- `laneway-icon-amber.svg`: ink mark on amber.

Colours: ink `#202827`, amber `#E6AA45`, optional light background `#F5F2E9`.

All assets use the same path. The app icon fits the mark to a 48-unit canvas;
the other assets use a 64-unit canvas. The passage is 8 units wide. Keep the passage open;
do not add strokes, shadows, or gradients. SVGs contain no fonts or external resources.

The desktop app's window and dock icons are rasterized from `laneway-icon.svg` into
`desktop/resources/icon.ico` and `icon.png`. Regenerate them after changing the mark:

```sh
bun run --cwd desktop icons
```
