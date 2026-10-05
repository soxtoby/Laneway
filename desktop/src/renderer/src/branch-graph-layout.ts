import type { BranchGraph, BranchGraphBranchNode } from "@laneway/shared"

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
    /** Whether the neighbouring rows label the same commit, so its node stretches to span them. */
    sameCommit: { above: boolean; below: boolean }
}

export let graphRowHeight = 40
let laneWidth = 12

export function graphLineColor(color: number) {
    let hues = [100, 215, 28, 275, 175, 345, 50, 315]
    return color == 0 ? "var(--graph)" : `hsl(${hues[color] ?? (color * 137.508 + 100) % 360} 65% var(--graph-line-lightness))`
}

/** Assign drawing lanes to verified history; filtering only contracts hidden rows. */
export function layoutBranchGraph(graph: BranchGraph, branches: BranchGraphBranchNode[]) {
    let labels = new Map<string, GraphNode[]>()
    let add = (objectId: string, node: GraphNode) => labels.set(objectId, [...labels.get(objectId) ?? [], node])
    let visible = new Set(branches.map(branch => branch.id))
    for (let branch of branches)
        add(branch.tip, { kind: "branch", id: branch.id, branch })
    for (let tag of graph.tags) {
        if (tag.parentBranchId && visible.has(tag.parentBranchId)) {
            visible.add(tag.id)
            add(tag.objectId, { kind: "tag", id: tag.id, name: tag.name, title: tag.tooltip })
        }
    }
    for (let branch of graph.virtualBranches) {
        visible.add(branch.id)
        add(branch.objectId, { kind: "worktree", id: branch.id, name: branch.name, title: branch.tooltip })
    }

    let history = new Map(graph.history.map(point => [point.objectId, point]))
    let included = new Set(graph.history.filter(point => visible.has(point.lineId) || labels.has(point.objectId)).map(point => point.objectId))
    let nearestVisible = new Map<string, string[]>()
    for (let point of [...graph.history].reverse()) {
        nearestVisible.set(
            point.objectId,
            included.has(point.objectId)
                ? [point.objectId]
                : [...new Set(point.parentIds.flatMap(parent => nearestVisible.get(parent) ?? []))],
        )
    }

    let points = graph.history.filter(point => included.has(point.objectId)).map(point => ({
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

    let primaryTip = branches.find(branch => branch.primary)?.tip
    // The Primary Branch keeps the first lane, but that lane stays undrawn until its tip or until another line joins it:
    // nothing exists above it to connect to.
    let lanes: Array<{ objectId: string; color: number; reserved?: boolean } | undefined> = primaryTip && included.has(primaryTip)
        ? [{ objectId: primaryTip, color: 0, reserved: true }]
        : []
    let events: Array<
        {
            node?: GraphNode
            objectId: string
            x: number
            color: number
            segments: Array<{ fromX: number; toX: number; top: number; bottom: number; color: number }>
            // Drawn lines still open once this event is processed.
            open?: number
        }
    > = []
    let reservedColors = new Set<number>()
    let width = 26
    let allocate = (objectId: string) => {
        let existing = lanes.findIndex(lane => lane?.objectId == objectId)
        if (existing >= 0)
            return existing
        let available = lanes.indexOf(undefined)
        let lane = available < 0 ? lanes.length : available
        let color = 0
        while (reservedColors.has(color))
            color++
        reservedColors.add(color)
        lanes[lane] = { objectId, color }
        width = Math.max(width, laneX(lane) + 13)

        return lane
    }

    for (let point of points) {
        // A departing line keeps its color through this event's joining curve.
        reservedColors = new Set(lanes.flatMap(lane => lane ? [lane.color] : []))
        let incoming = lanes.findIndex(lane => lane?.objectId == point.objectId)
        let lane = incoming < 0 ? allocate(point.objectId) : incoming
        let color = lanes[lane]!.color
        let reserved = lanes[lane]!.reserved
        let x = laneX(lane)
        let nodes = labels.get(point.objectId) ?? [undefined]
        for (let [index, node] of nodes.entries()) {
            let segments = lanes.flatMap((target, other) =>
                target && other != lane && !target.reserved ? [{ fromX: laneX(other), toX: laneX(other), top: 0, bottom: 40, color: target.color }] : []
            )
            if (incoming >= 0 && events.length > 0 && !reserved || index > 0)
                segments.push({ fromX: x, toX: x, top: 0, bottom: 20, color })
            if (index < nodes.length - 1)
                segments.push({ fromX: x, toX: x, top: 20, bottom: 40, color })
            else {
                lanes[lane] = undefined
                for (let [parentIndex, parent] of point.parentIds.entries()) {
                    let existing = lanes.findIndex(lane => lane?.objectId == parent)
                    if (parentIndex == 0 && existing >= 0 && history.get(parent)?.lineId == point.lineId) {
                        // Keep a branch's own rail straight when another line already
                        // reaches its next waypoint; bring that line into this lane.
                        let otherX = laneX(existing)
                        let through = segments.find(segment => segment.fromX == otherX && segment.top == 0 && segment.bottom == 40)
                        if (through) {
                            through.bottom = 20
                            segments.push({ fromX: otherX, toX: x, top: 20, bottom: 40, color: through.color })
                        }
                        lanes[existing] = undefined
                    }
                    if (parentIndex == 0 && !lanes.some(lane => lane?.objectId == parent))
                        lanes[lane] = { objectId: parent, color }
                    let parentLane = allocate(parent)
                    // A line joining the reserved Primary lane starts drawing it from here down.
                    lanes[parentLane]!.reserved = false
                    let parentX = laneX(parentLane)
                    segments.push({ fromX: x, toX: parentX, top: 20, bottom: 40, color: parentIndex == 0 ? color : lanes[parentLane]!.color })
                }
            }
            events.push({ node, objectId: point.objectId, x, color, segments, open: lanes.filter(lane => lane && !lane.reserved).length })
        }
    }

    // Unborn heads and unavailable objects have no verified ancestry to draw.
    for (let [objectId, nodes] of labels) {
        if (!history.has(objectId)) {
            for (let node of nodes)
                events.push({ node, objectId, x: laneX(0), color: 0, segments: [] })
        }
    }

    // Forks and merges are bends between branch/tag rows, never commit nodes.
    let rows: GraphRowLayout[] = []
    let centers = new Map<number, number>()
    for (let [index, event] of events.entries()) {
        if (event.node) {
            centers.set(index, rows.length * graphRowHeight + 20)
            // Labels of one commit are consecutive events.
            let previous = rows.at(-1)
            let above = previous?.objectId == event.objectId
            if (previous && above)
                previous.sameCommit.below = true
            rows.push({
                node: event.node,
                objectId: event.objectId,
                x: event.x,
                width: event.x + 13,
                color: event.color,
                paths: [],
                sameCommit: { above, below: false },
            })
        }
    }
    if (rows.length == 0)
        return { rows, width }

    let anchors = [[-1, 0], ...centers, [events.length, rows.length * graphRowHeight]]
    for (let index = 1; index < anchors.length; index++) {
        let [before, top] = anchors[index - 1]
        let [after, bottom] = anchors[index]
        for (let event = before + 1; event < after; event++)
            centers.set(event, top + (bottom - top) * (event - before) / (after - before))
    }

    // Past the last row, lines matter only until the visible branches have met; after that a lone line would just
    // lead to unlisted commits. Stop at that join, or at the event's own node when nothing joins there.
    let lastRowEvent = events.findLastIndex(event => event.node)
    let settled = events.findIndex((event, index) => index >= lastRowEvent && event.open != undefined && event.open <= 1)
    let endAtNode = settled >= 0 && !events[settled].segments.some(segment => segment.fromX != segment.toX)
    let verticals = rows.map(() => new Map<string, { x: number; color: number; ranges: Array<{ start: number; end: number }> }>())
    for (let [index, event] of events.entries()) {
        if (settled >= 0 && index > settled)
            break
        let center = centers.get(index)!
        let top = index == 0 ? 0 : (centers.get(index - 1)! + center) / 2
        let bottom = index == events.length - 1 ? rows.length * graphRowHeight : (center + centers.get(index + 1)!) / 2
        let y = (value: number) => value == 0 ? top : value == 20 ? center : bottom
        for (let segment of event.segments) {
            let until = index == settled && endAtNode ? Math.min(segment.bottom, 20) : segment.bottom
            if (until <= segment.top)
                continue
            let from = y(segment.top)
            let to = y(until)
            let firstRow = Math.max(0, Math.floor(from / graphRowHeight))
            let lastRow = Math.min(rows.length - 1, Math.ceil(to / graphRowHeight) - 1)
            for (let row = firstRow; row <= lastRow; row++) {
                let offset = row * graphRowHeight
                let start = from - offset
                let end = to - offset
                rows[row].width = Math.max(rows[row].width, segment.fromX + 13, segment.toX + 13)
                if (segment.fromX == segment.toX) {
                    let key = `${segment.fromX}:${segment.color}`
                    let column = verticals[row].get(key) ?? { x: segment.fromX, color: segment.color, ranges: [] }
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

    for (let [index, columns] of verticals.entries()) {
        for (let { x, color, ranges } of columns.values()) {
            let joined: typeof ranges = []
            for (let range of ranges.sort((left, right) => left.start - right.start)) {
                let previous = joined.at(-1)
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

function laneX(lane: number) {
    return 13 + lane * laneWidth
}
