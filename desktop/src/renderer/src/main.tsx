import { createRoot } from "remix/ui"
import { WorkbenchApp } from "./app"

const app = document.querySelector<HTMLDivElement>("#app")
if (!app)
    throw new Error("Workbench root element was not found.")

const root = createRoot(app)
root.addEventListener("error", event => console.error("Remix renderer failed.", event.error))
root.render(<WorkbenchApp api={window.workbench} />)
