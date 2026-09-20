// THROWAWAY entry: the server substitutes only the Working Changes subtree.
import { createRoot } from "remix/ui"
import { inspectionScenario } from "../../../test/renderer-fixtures"
import { LanewayApp } from "./app"

const { api } = inspectionScenario()
const getState = api.getState
api.getState = async () => {
    const state = await getState()
    for (const repository of state.workspace.repositories) {
        for (const column of repository.columns)
            column.width = 530
    }
    return state
}
const root = createRoot(document.querySelector<HTMLDivElement>("#app")!)
root.addEventListener("error", event => console.error(event.error))
root.render(<LanewayApp api={api} />)
