# @laneway/markdown-diff

Compares two versions of a GitHub Flavored Markdown document as they render. It knows nothing of Laneway, so it can be published on its own ([ADR 0028](../docs/adr/0028-diff-rendered-markdown-with-an-extractable-engine.md)).

```ts
import { diffMarkdown } from "@laneway/markdown-diff"

let { rows } = diffMarkdown(oldMarkdown, newMarkdown)
```

Each row is one aligned block, as [hast](https://github.com/syntax-tree/hast) a renderer can turn into React with `hast-util-to-jsx-runtime` or into HTML with `hast-util-to-html`:

- `change`: `unchanged`, `added`, `removed`, or `changed`.
- `old` and `new`: each version's block, absent for an added or removed one, for side-by-side layouts.
- `unified`: both versions in one, for a single document.

Changed elements carry `data-diff`: `added`, `removed`, or `changed` on blocks, list items, table rows, and code lines. Inserted words are `<ins data-diff="added">`, deleted ones `<del data-diff="removed">`, and words whose formatting alone changed are `<span data-diff="modified">`, whose `data-diff-before` lists the formatting they had (`strong`, `emphasis`, `delete`, `link=<url>`, `linkReference=<identifier>`). Strikethrough renders as `<s>`. A missing version compares as empty. Embedded HTML is sanitized with GitHub's schema.
