// Declared by hand so TypeScript never types the 1,900-icon JSON documents themselves.
declare module "lucide-static/icon-nodes.json" {
    let nodes: Record<string, [tag: string, attributes: Record<string, string | number>][]>
    export default nodes
}

declare module "lucide-static/tags.json" {
    let tags: Record<string, string[]>
    export default tags
}
