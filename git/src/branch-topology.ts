import type { GraphRunner, MutableBranch } from "./branch-graph"

export interface TopologyRecord {
    objectId: string
    parentIds: string[]
}

export interface TopologyCache {
    key: string
    tips: string[]
    records: TopologyRecord[]
    indexes: Map<string, number>
    graph: GraphTopology
}

export interface TopologyCommit {
    objectId: string
    parentIndexes: number[]
}

export interface GraphTopology {
    commits: TopologyCommit[]
    isAncestor(ancestor: string, descendant: string): boolean
    ancestry(roots: string[]): (ancestor: string, descendant: string) => boolean
    mergeBases(branch: MutableBranch, candidates: MutableBranch[]): Array<{ candidate: MutableBranch; objectId: string }>
    exclusiveCommits(branches: MutableBranch[], candidates?: string[]): string[]
    hasExclusive(commits: Set<string>, tip: string, base: string): boolean
}

export async function readTopology(runner: GraphRunner, tips: string[], key: string, cached?: TopologyCache): Promise<TopologyCache> {
    let reusable = cached?.key == key ? cached : undefined
    if (reusable && tips.length == reusable.tips.length && tips.every(tip => reusable.tips.includes(tip)))
        return reusable
    let records: TopologyRecord[] | undefined
    if (reusable) {
        let added = tips.filter(tip => !reusable.indexes.has(tip))
        let result = added.length
            ? await runner.run(
                ["rev-list", "--topo-order", "--parents", "--stdin"],
                [0, 128],
                [...added, ...reusable.tips.map(tip => `^${tip}`), ""].join("\n"),
            )
            : undefined
        if (!result?.exitCode) {
            // New records precede the cached ancestry; both portions remain topologically ordered.
            let addedRecords = result ? parseTopology(result.stdout.toString()) : []
            let byId = new Map(addedRecords.map(record => [record.objectId, record]))
            let reachable = new Set<string>(), pending = [...tips]
            while (pending.length) {
                let objectId = pending.pop()!
                if (reachable.has(objectId))
                    continue
                reachable.add(objectId)
                let record = byId.get(objectId) ?? reusable.records[reusable.indexes.get(objectId)!]
                pending.push(...record?.parentIds ?? [])
            }
            records = [...addedRecords, ...reusable.records.filter(record => reachable.has(record.objectId))]
        }
    }
    // An excluded old tip may have been collected after an external rewrite. Re-read current roots.
    records ??= tips.length
        ? parseTopology((await runner.run(["rev-list", "--topo-order", "--parents", "--stdin"], [0], tips.join("\n") + "\n")).stdout.toString().trim())
        : []
    let indexes = new Map(records.map((record, index) => [record.objectId, index]))
    return { key, tips, records, indexes, graph: createTopology(records, tips, indexes) }
}

function createTopology(records: TopologyRecord[], tips: string[], commitIndexes: Map<string, number>): GraphTopology {
    if (!tips.length)
        return emptyTopology()
    let commits: TopologyCommit[] = records.map(commit => ({
        objectId: commit.objectId,
        parentIndexes: commit.parentIds.map(parentId => commitIndexes.get(parentId))
            .filter((index): index is number => index != undefined),
    }))
    let tipIndexes = new Map(tips.map((objectId, index) => [objectId, index]))
    let wordCount = Math.ceil(tips.length / 32)
    let reachability = new Uint32Array(commits.length * wordCount)

    for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
        let commit = commits[commitIndex]
        let tipIndex = tipIndexes.get(commit.objectId)
        if (tipIndex != undefined)
            reachability[commitIndex * wordCount + Math.floor(tipIndex / 32)] |= 1 << tipIndex % 32
        for (let parentIndex of commit.parentIndexes) {
            for (let word = 0; word < wordCount; word += 1)
                reachability[parentIndex * wordCount + word] |= reachability[commitIndex * wordCount + word]
        }
    }

    let ancestorCache = new Map<string, boolean>()
    let hasReach = (commitIndex: number, tipIndex: number) => (reachability[commitIndex * wordCount + Math.floor(tipIndex / 32)] & 1 << tipIndex % 32) != 0
    let isAncestor = (ancestor: string, descendant: string) => {
        if (ancestor == descendant)
            return true
        let ancestorIndex = commitIndexes.get(ancestor)
        let descendantIndex = commitIndexes.get(descendant)
        if (ancestorIndex == undefined || descendantIndex == undefined || ancestorIndex < descendantIndex)
            return false
        let descendantTipIndex = tipIndexes.get(descendant)
        if (descendantTipIndex != undefined)
            return hasReach(ancestorIndex, descendantTipIndex)
        let key = `${ancestor}\0${descendant}`
        let cached = ancestorCache.get(key)
        if (cached != undefined)
            return cached
        let pending = [descendantIndex]
        let visited = new Set<number>()
        let found = false
        while (pending.length > 0 && !found) {
            let current = pending.pop()!
            if (current == ancestorIndex) {
                found = true
                break
            }
            if (current > ancestorIndex || visited.has(current))
                continue
            visited.add(current)
            pending.push(...commits[current].parentIndexes)
        }
        ancestorCache.set(key, found)
        return found
    }

    return {
        commits,
        isAncestor,
        ancestry(roots) {
            let uniqueRoots = [...new Set(roots)]
            let rootIndexes = new Map(uniqueRoots.map((objectId, index) => [objectId, index]))
            let rootWordCount = Math.ceil(uniqueRoots.length / 32)
            let rootReachability = new Uint32Array(commits.length * rootWordCount)
            for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
                let rootIndex = rootIndexes.get(commits[commitIndex].objectId)
                if (rootIndex != undefined)
                    rootReachability[commitIndex * rootWordCount + Math.floor(rootIndex / 32)] |= 1 << rootIndex % 32
                for (let parentIndex of commits[commitIndex].parentIndexes) {
                    for (let word = 0; word < rootWordCount; word += 1)
                        rootReachability[parentIndex * rootWordCount + word] |= rootReachability[commitIndex * rootWordCount + word]
                }
            }
            return (ancestor: string, descendant: string) => {
                if (ancestor == descendant)
                    return true
                let ancestorIndex = commitIndexes.get(ancestor)
                let descendantRootIndex = rootIndexes.get(descendant)
                if (ancestorIndex == undefined || descendantRootIndex == undefined)
                    return false
                return (rootReachability[ancestorIndex * rootWordCount + Math.floor(descendantRootIndex / 32)] & 1 << descendantRootIndex % 32) != 0
            }
        },
        mergeBases(branch, candidates) {
            let branchTipIndex = tipIndexes.get(branch.tip)
            if (branchTipIndex == undefined)
                return []
            let unresolved = new Uint32Array(wordCount)
            let candidatesByTipIndex = new Map<number, MutableBranch>()
            for (let candidate of candidates) {
                let candidateTipIndex = tipIndexes.get(candidate.tip)
                if (
                    candidate.id == branch.id
                    || candidate.tip == branch.tip
                    || candidateTipIndex == undefined
                    || isAncestor(branch.tip, candidate.tip)
                ) {
                    continue
                }
                unresolved[Math.floor(candidateTipIndex / 32)] |= 1 << candidateTipIndex % 32
                candidatesByTipIndex.set(candidateTipIndex, candidate)
            }
            let unresolvedCount = candidatesByTipIndex.size
            let result: Array<{ candidate: MutableBranch; objectId: string }> = []
            for (let commitIndex = 0; commitIndex < commits.length && unresolvedCount > 0; commitIndex += 1) {
                if (!hasReach(commitIndex, branchTipIndex))
                    continue
                let offset = commitIndex * wordCount
                for (let word = 0; word < wordCount; word += 1) {
                    let matching = (reachability[offset + word] & unresolved[word]) >>> 0
                    while (matching != 0) {
                        let lowest = (matching & -matching) >>> 0
                        let bit = 31 - Math.clz32(lowest)
                        let candidate = candidatesByTipIndex.get(word * 32 + bit)
                        if (candidate)
                            result.push({ candidate, objectId: commits[commitIndex].objectId })
                        unresolved[word] &= ~lowest
                        unresolvedCount -= 1
                        matching = (matching & (matching - 1)) >>> 0
                    }
                }
            }
            return result
        },
        exclusiveCommits(branches, candidates) {
            let ranges = branches.flatMap(branch => {
                if (branch.base.status != "known")
                    return []
                let tipIndex = tipIndexes.get(branch.tip)
                let baseIndex = tipIndexes.get(branch.base.tip)
                return tipIndex == undefined || baseIndex == undefined ? [] : [{ tipIndex, baseIndex }]
            })
            let result: string[] = []
            let indexes = candidates ? candidates.map(objectId => commitIndexes.get(objectId)!).filter(index => index != undefined) : commits.keys()
            for (let commitIndex of indexes) {
                for (let range of ranges) {
                    if (hasReach(commitIndex, range.tipIndex) && !hasReach(commitIndex, range.baseIndex)) {
                        result.push(commits[commitIndex].objectId)
                        break
                    }
                }
            }
            return result
        },
        hasExclusive(objectIds, tip, base) {
            let tipIndex = tipIndexes.get(tip)
            let baseIndex = tipIndexes.get(base)
            if (tipIndex == undefined || baseIndex == undefined)
                return false
            for (let objectId of objectIds) {
                let commitIndex = commitIndexes.get(objectId)
                if (commitIndex != undefined && hasReach(commitIndex, tipIndex) && !hasReach(commitIndex, baseIndex))
                    return true
            }
            return false
        },
    }
}

function parseTopology(output: string) {
    let records: TopologyRecord[] = []
    let lineStart = 0
    while (lineStart < output.length) {
        let lineEnd = output.indexOf("\n", lineStart)
        if (lineEnd < 0)
            lineEnd = output.length
        let separator = output.indexOf(" ", lineStart)
        let objectEnd = separator < 0 || separator > lineEnd ? lineEnd : separator
        let parentIds: string[] = []
        let parentStart = objectEnd + 1
        while (parentStart < lineEnd) {
            let nextSeparator = output.indexOf(" ", parentStart)
            let parentEnd = nextSeparator < 0 || nextSeparator > lineEnd ? lineEnd : nextSeparator
            parentIds.push(output.slice(parentStart, parentEnd))
            parentStart = parentEnd + 1
        }
        if (objectEnd > lineStart)
            records.push({ objectId: output.slice(lineStart, objectEnd), parentIds })
        lineStart = lineEnd + 1
    }
    return records
}

function emptyTopology(): GraphTopology {
    return {
        commits: [],
        isAncestor: () => false,
        ancestry: () => () => false,
        mergeBases: () => [],
        exclusiveCommits: () => [],
        hasExclusive: () => false,
    }
}
