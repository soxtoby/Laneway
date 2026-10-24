// Declared by hand so TypeScript never types the 5,000-icon JSON documents themselves. Neither file is
// in the package's exports, so the Vite config and, for Bun, `tsconfig.json` map them to the package.
declare module "@tabler/icons/tabler-nodes-outline.json" {
    let nodes: Record<string, [tag: string, attributes: Record<string, string>][]>
    export default nodes
}

declare module "@tabler/icons/icons.json" {
    let icons: Record<string, { tags: (string | number)[] }>
    export default icons
}
