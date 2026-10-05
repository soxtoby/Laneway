// THROWAWAY entry: the server substitutes only the Working Changes subtree.
import { createRoot } from "remix/ui"
import { inspectionScenario } from "../../../test/renderer-fixtures"
import { LanewayApp } from "./app"

let { api } = inspectionScenario()
let getState = api.getState
api.getState = async () => {
    let state = await getState()
    for (let repository of state.workspace.repositories) {
        for (let column of repository.columns)
            column.width = 530
    }
    return state
}
let root = createRoot(document.querySelector<HTMLDivElement>("#app")!)
root.addEventListener("error", event => console.error(event.error))
root.render(<LanewayApp api={api} />)
