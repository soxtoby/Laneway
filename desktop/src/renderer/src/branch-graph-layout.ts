import type { BranchGraph, BranchGraphBranchNode } from "@git-workbench/shared"

export type GraphNode =
    | { kind: "branch"; id: string; branch: BranchGraphBranchNode }
    | { kind: "tag" | "worktree"; id: string; name: string; title: string }

export interface GraphRowLayout {
    node: GraphNode
    objectId: string
    x: number
    width: number
    color: number
    paths: Array<{ d: string; color: number }>
}

export function graphLineColor(color: number) {
    const hues = [100, 215, 28, 275, 175, 345, 50, 315]
    return color == 0 ? "var(--accent)" : `hsl(${hues[color] ?? (color * 137.508 + 100) % 360} 65% var(--graph-line-lightness))`
}

export const graphRowHeight = 40
const laneWidth = 12
const laneX = (lane: number) => 13 + lane * laneWidth

/** Assign drawing lanes to verified history; filtering only contracts hidden rows. */
export function layoutBranchGraph(graph: BranchGraph, branches: BranchGraphBranchNode[]) {
    const labels = new Map<string, GraphNode[]>()
    const add = (objectId: string, node: GraphNode) => labels.set(objectId, [...labels.get(objectId) ?? [], node])
    const visible = new Set(branches.map(branch => branch.id))
    for (const branch of branches)
        add(branch.tip, { kind: "branch", id: branch.id, branch })
    for (const tag of graph.tags) {
        if (tag.parentBranchId && visible.has(tag.parentBranchId)) {
            visible.add(tag.id)
            add(tag.objectId, { kind: "tag", id: tag.id, name: tag.name, title: tag.tooltip })
        }
    }
    for (const branch of graph.virtualBranches) {
        visible.add(branch.id)
        add(branch.objectId, { kind: "worktree", id: branch.id, name: branch.name, title: branch.tooltip })
    }
    const history = new Map(graph.history.map(point => [point.objectId, point]))
    const included = new Set(graph.history.filter(point => visible.has(point.lineId) || labels.has(point.objectId)).map(point => point.objectId))
    const nearestVisible = new Map<string, string[]>()
    for (const point of [...graph.history].reverse()) {
        nearestVisible.set(
            point.objectId,
            included.has(point.objectId)
                ? [point.objectId]
                : [...new Set(point.parentIds.flatMap(parent => nearestVisible.get(parent) ?? []))],
        )
    }
    const points = graph.history.filter(point => included.has(point.objectId)).map(point => ({
        ...point,
        parentIds: [
            ...new Set(point.parentIds.flatMap((parent, index) =>
                (nearestVisible.get(parent) ?? []).filter(target =>
                    // Contract hidden intermediates without losing a visible merged
                    // branch or adding a duplicate return to the current base line.
                    index == 0 || included.has(parent) || history.get(target)?.lineId != point.lineId
                )
            )),
        ],
    }))
    const primaryTip = branches.find(branch => branch.primary)?.tip
    const lanes: Array<{ objectId: string; color: number } | undefined> = primaryTip && included.has(primaryTip) ? [{ objectId: primaryTip, color: 0 }] : []
    const events: Array<
        {
            node?: GraphNode
            objectId: string
            x: number
            color: number
            segments: Array<{ fromX: number; toX: number; top: number; bottom: number; color: number }>
        }
    > = []
    let reservedColors = new Set<number>()
    let width = 26
    const allocate = (objectId: string) => {
        const existing = lanes.findIndex(lane => lane?.objectId == objectId)
        if (existing >= 0)
            return existing
        const available = lanes.indexOf(undefined)
        const lane = available < 0 ? lanes.length : available
        let color = 0
        while (reservedColors.has(color))
            color++
        reservedColors.add(color)
        lanes[lane] = { objectId, color }
        width = Math.max(width, laneX(lane) + 13)
        return lane
    }
    for (const point of points) {
        // A departing line keeps its color through this event's joining curve.
        reservedColors = new Set(lanes.flatMap(lane => lane ? [lane.color] : []))
        const incoming = lanes.findIndex(lane => lane?.objectId == point.objectId)
        const lane = incoming < 0 ? allocate(point.objectId) : incoming
        const color = lanes[lane]!.color
        const x = laneX(lane)
        const nodes = labels.get(point.objectId) ?? [undefined]
        for (const [index, node] of nodes.entries()) {
            const segments = lanes.flatMap((target, other) =>
                target && other != lane ? [{ fromX: laneX(other), toX: laneX(other), top: 0, bottom: 40, color: target.color }] : []
            )
            if (incoming >= 0 && events.length > 0 || index > 0)
                segments.push({ fromX: x, toX: x, top: 0, bottom: 20, color })
            if (index < nodes.length - 1)
                segments.push({ fromX: x, toX: x, top: 20, bottom: 40, color })
            else {
                lanes[lane] = undefined
                for (const [parentIndex, parent] of point.parentIds.entries()) {
                    const existing = lanes.findIndex(lane => lane?.objectId == parent)
                    if (parentIndex == 0 && existing >= 0 && history.get(parent)?.lineId == point.lineId) {
                        // Keep a branch's own rail straight when another line already
                        // reaches its next waypoint; bring that line into this lane.
                        const otherX = laneX(existing)
                        const through = segments.find(segment => segment.fromX == otherX && segment.top == 0 && segment.bottom == 40)
                        if (through) {
                            through.bottom = 20
                            segments.push({ fromX: otherX, toX: x, top: 20, bottom: 40, color: through.color })
                        }
                        lanes[existing] = undefined
                    }
                    if (parentIndex == 0 && !lanes.some(lane => lane?.objectId == parent))
                        lanes[lane] = { objectId: parent, color }
                    const parentLane = allocate(parent)
                    const parentX = laneX(parentLane)
                    segments.push({ fromX: x, toX: parentX, top: 20, bottom: 40, color: parentIndex == 0 ? color : lanes[parentLane]!.color })
                }
            }
            events.push({ node, objectId: point.objectId, x, color, segments })
        }
    }
    // Unborn heads and unavailable objects have no verified ancestry to draw.
    for (const [objectId, nodes] of labels) {
        if (!history.has(objectId)) {
            for (const node of nodes)
                events.push({ node, objectId, x: laneX(0), color: 0, segments: [] })
        }
    }
    // Forks and merges are bends between branch/tag rows, never commit nodes.
    const rows: GraphRowLayout[] = []
    const centers = new Map<number, number>()
    for (const [index, event] of events.entries()) {
        if (event.node) {
            centers.set(index, rows.length * graphRowHeight + 20)
            rows.push({ node: event.node, objectId: event.objectId, x: event.x, width: event.x + 13, color: event.color, paths: [] })
        }
    }
    if (rows.length == 0)
        return { rows, width }
    const anchors = [[-1, 0], ...centers, [events.length, rows.length * graphRowHeight]]
    for (let index = 1; index < anchors.length; index++) {
        const [before, top] = anchors[index - 1]
        const [after, bottom] = anchors[index]
        for (let event = before + 1; event < after; event++)
            centers.set(event, top + (bottom - top) * (event - before) / (after - before))
    }
    const verticals = rows.map(() => new Map<string, { x: number; color: number; ranges: Array<{ start: number; end: number }> }>())
    for (const [index, event] of events.entries()) {
        const center = centers.get(index)!
        const top = index == 0 ? 0 : (centers.get(index - 1)! + center) / 2
        const bottom = index == events.length - 1 ? rows.length * graphRowHeight : (center + centers.get(index + 1)!) / 2
        const y = (value: number) => value == 0 ? top : value == 20 ? center : bottom
        for (const segment of event.segments) {
            const from = y(segment.top)
            const to = y(segment.bottom)
            const firstRow = Math.max(0, Math.floor(from / graphRowHeight))
            const lastRow = Math.min(rows.length - 1, Math.ceil(to / graphRowHeight) - 1)
            for (let row = firstRow; row <= lastRow; row++) {
                const offset = row * graphRowHeight
                const start = from - offset
                const end = to - offset
                rows[row].width = Math.max(rows[row].width, segment.fromX + 13, segment.toX + 13)
                if (segment.fromX == segment.toX) {
                    const key = `${segment.fromX}:${segment.color}`
                    const column = verticals[row].get(key) ?? { x: segment.fromX, color: segment.color, ranges: [] }
                    column.ranges.push({ start: Math.max(0, start), end: Math.min(graphRowHeight, end) })
                    verticals[row].set(key, column)
                } else {
                    rows[row].paths.push({
                        d: `M ${segment.fromX} ${start} C ${segment.fromX} ${start + (end - start) * .6} ${segment.toX} ${
                            start + (end - start) * .4
                        } ${segment.toX} ${end}`,
                        color: segment.color,
                    })
                }
            }
        }
    }
    for (const [index, columns] of verticals.entries()) {
        for (const { x, color, ranges } of columns.values()) {
            const joined: typeof ranges = []
            for (const range of ranges.sort((left, right) => left.start - right.start)) {
                const previous = joined.at(-1)
                if (previous && range.start <= previous.end)
                    previous.end = Math.max(previous.end, range.end)
                else
                    joined.push({ ...range })
            }
            rows[index].paths.push(...joined.map(range => ({ d: `M ${x} ${range.start} V ${range.end}`, color })))
        }
    }
    return { rows, width }
}
