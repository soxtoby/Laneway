import type { BranchGraphPoint } from "@git-workbench/shared"

/** Keep the first-parent lines of visible refs, plus their actual merge connections.
 * Ordinary commits are compressed; heads, tags, forks and merges remain waypoints. */
export function graphHistory(
    commits: Array<{ objectId: string; parentIndexes: number[] }>,
    heads: Array<{ objectId: string; lineId: string; connect?: boolean }>,
): BranchGraphPoint[] {
    const indexes = new Map(commits.map((commit, index) => [commit.objectId, index]))
    const owners = new Map<number, string>()
    const parents = new Map<number, number[]>()
    const labelled = new Set(heads.map(head => indexes.get(head.objectId)))
    const branchHeads = [...new Set(heads.filter(head => head.connect != false).map(head => indexes.get(head.objectId)))]
    const wordCount = Math.ceil(branchHeads.length / 32)
    const reachableHeads = new Uint32Array(commits.length * wordCount)
    for (const [bit, index] of branchHeads.entries()) {
        if (index != undefined)
            reachableHeads[index * wordCount + Math.floor(bit / 32)] |= 1 << bit % 32
    }
    for (let index = commits.length - 1; index >= 0; index--) {
        for (const parent of commits[index].parentIndexes) {
            for (let word = 0; word < wordCount; word++)
                reachableHeads[index * wordCount + word] |= reachableHeads[parent * wordCount + word]
        }
    }
    for (const head of heads) {
        let index = indexes.get(head.objectId)
        while (index != undefined && !owners.has(index)) {
            owners.set(index, head.lineId)
            const parent = commits[index].parentIndexes[0]
            parents.set(index, parent == undefined ? [] : [parent])
            index = parent
        }
    }

    // Show one return for each branch head, preferring the first line supplied
    // (the Primary Branch). Its intermediate merge commits are not graph nodes.
    const connected = new Set(
        heads.filter(head => head.connect != false && owners.get(indexes.get(head.objectId)!) != head.lineId).map(head => indexes.get(head.objectId)),
    )
    for (const [index, owner] of owners) {
        for (const parent of commits[index].parentIndexes.slice(1)) {
            const firstParent = commits[index].parentIndexes[0]
            for (let word = 0; word < wordCount; word++) {
                let introduced = (reachableHeads[parent * wordCount + word] & ~reachableHeads[firstParent * wordCount + word]) >>> 0
                while (introduced) {
                    const bit = 31 - Math.clz32((introduced & -introduced) >>> 0)
                    const head = branchHeads[word * 32 + bit]
                    if (head != undefined && !connected.has(head) && owners.get(head) != owner) {
                        parents.get(index)!.push(head)
                        connected.add(head)
                    }
                    introduced = (introduced & (introduced - 1)) >>> 0
                }
            }
        }
    }

    const children = new Map<number, number>()
    for (const values of parents.values()) {
        for (const parent of values)
            children.set(parent, (children.get(parent) ?? 0) + 1)
    }
    const retained = new Set([...owners.keys()].filter(index => labelled.has(index) || parents.get(index)!.length != 1 || children.get(index) != 1))
    return commits.flatMap((commit, index) => {
        if (!retained.has(index))
            return []
        return [{
            objectId: commit.objectId,
            lineId: owners.get(index)!,
            parentIds: parents.get(index)!.map(parent => {
                while (!retained.has(parent))
                    parent = parents.get(parent)![0]
                return commits[parent].objectId
            }),
        }]
    })
}
