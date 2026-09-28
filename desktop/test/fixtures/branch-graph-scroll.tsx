import { createRoot } from "remix/ui"
import { LanewayApp } from "../../src/renderer/src/app"
import { inspectionScenario } from "../renderer-fixtures"

export async function checkBranchGraphScroll() {
    const scenario = inspectionScenario()
    const readGraph = scenario.api.readBranchGraph
    scenario.api.readBranchGraph = async (...args) => {
        const result = await readGraph(...args)
        if (result.ok) {
            const [main, feature] = result.graph.branches
            result.graph.branches = [
                main,
                ...Array.from({ length: 75 }, (_, index) => ({
                    ...feature,
                    id: `branch:${index}`,
                    name: `feature/${index}`,
                    tip: `tip-${index}`,
                })),
            ]
            result.graph.tags = []
            result.graph.history = [...result.graph.branches.slice(1).map(branch => ({ objectId: branch.tip, lineId: branch.id, parentIds: [main.tip] })), {
                objectId: main.tip,
                lineId: main.id,
                parentIds: [],
            }]
        }
        return result
    }
    const root = createRoot(document.querySelector<HTMLElement>("#app")!)
    root.render(<LanewayApp api={scenario.api} />)
    async function settle() {
        for (let frame = 0; frame < 3; frame++) {
            await new Promise(resolve => setTimeout(resolve, 20))
            root.flush()
        }
    }
    try {
        await settle()
        document.querySelector<HTMLButtonElement>("[aria-label='Show Branch Graph']")!.click()
        await settle()
        const scroller = document.querySelector<HTMLElement>(".graph-rows")!
        const height = scroller.scrollHeight
        let maximumDrift = 0
        for (const position of [80, 160, 240, 320, 400, 480, 560, 1200, 1280, 1360, 1280, 1200, 560, 480, 400, 320, 240, 160, 80, 0]) {
            scroller.scrollTop = position
            await settle()
            maximumDrift = Math.max(maximumDrift, Math.abs(scroller.scrollTop - position))
            if (scroller.scrollHeight != height)
                throw new Error(`Graph height changed while scrolling: ${height} -> ${scroller.scrollHeight}`)
        }
        return maximumDrift
    } finally {
        root.dispose()
    }
}
