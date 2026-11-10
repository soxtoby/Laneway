import type { BranchGraphPoint } from "@laneway/shared"

/** Keep the first-parent lines of visible refs, plus their actual merge connections.
 * Ordinary commits are compressed; heads, tags, forks and merges remain waypoints. */
export function graphHistory(
    commits: Array<{ objectId: string; parentIndexes: number[] }>,
    heads: Array<{ objectId: string; lineId: string; connect?: boolean }>,
): BranchGraphPoint[] {
    let indexes = new Map(commits.map((commit, index) => [commit.objectId, index]))
    let owners = new Map<number, string>()
    let parents = new Map<number, number[]>()
    let labeled = new Set(heads.map(head => indexes.get(head.objectId)))
    let branchHeads = [...new Set(heads.filter(head => head.connect != false).map(head => indexes.get(head.objectId)))]
    let wordCount = Math.ceil(branchHeads.length / 32)
    let reachableHeads = new Uint32Array(commits.length * wordCount)

    for (let [bit, index] of branchHeads.entries()) {
        if (index != undefined)
            reachableHeads[index * wordCount + Math.floor(bit / 32)] |= 1 << bit % 32
    }
    for (let index = commits.length - 1; index >= 0; index--) {
        for (let parent of commits[index].parentIndexes) {
            for (let word = 0; word < wordCount; word++)
                reachableHeads[index * wordCount + word] |= reachableHeads[parent * wordCount + word]
        }
    }

    for (let head of heads) {
        let index = indexes.get(head.objectId)
        while (index != undefined && !owners.has(index)) {
            owners.set(index, head.lineId)
            let parent = commits[index].parentIndexes[0]
            parents.set(index, parent == undefined ? [] : [parent])
            index = parent
        }
    }

    // Show one return for each branch head, preferring the first line supplied
    // (the Primary Branch). Its intermediate merge commits are not graph nodes.
    // A head on a line that never returns (fast-forwarded into the Primary Branch)
    // is already home; one on another branch's line returns through that line only
    // when the same merge brings that line's head in too.
    let headBits = new Map(branchHeads.map((index, bit) => [index, bit]))
    let lineBits = new Map(heads.filter(head => head.connect != false).map(head => [head.lineId, headBits.get(indexes.get(head.objectId))]))
    let connected = new Set(
        heads.filter(head => {
            let owner = owners.get(indexes.get(head.objectId)!)
            return head.connect != false && owner != head.lineId && !lineBits.has(owner!)
        }).map(head => indexes.get(head.objectId)),
    )
    for (let [index, owner] of owners) {
        for (let parent of commits[index].parentIndexes.slice(1)) {
            let firstParent = commits[index].parentIndexes[0]
            let introduced = Array.from(
                { length: wordCount },
                (_, word) => (reachableHeads[parent * wordCount + word] & ~reachableHeads[firstParent * wordCount + word]) >>> 0,
            )
            let brought = (bit: number | undefined) => bit != undefined && (introduced[Math.floor(bit / 32)] & 1 << bit % 32) != 0
            for (let word = 0; word < wordCount; word++) {
                let remaining = introduced[word]
                while (remaining) {
                    let bit = 31 - Math.clz32((remaining & -remaining) >>> 0)
                    let head = branchHeads[word * 32 + bit]
                    if (head != undefined && !connected.has(head) && owners.get(head) != owner) {
                        let headOwner = lineBits.get(owners.get(head)!)
                        if (headOwner == word * 32 + bit || !brought(headOwner))
                            parents.get(index)!.push(head)
                        connected.add(head)
                    }
                    remaining = (remaining & (remaining - 1)) >>> 0
                }
            }
        }
    }

    let children = new Map<number, number>()
    for (let values of parents.values()) {
        for (let parent of values)
            children.set(parent, (children.get(parent) ?? 0) + 1)
    }
    let retained = new Set([...owners.keys()].filter(index => labeled.has(index) || parents.get(index)!.length != 1 || children.get(index) != 1))

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
