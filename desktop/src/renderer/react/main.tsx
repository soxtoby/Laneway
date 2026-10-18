// The kit's variables and utilities load once, before its components and Laneway's theme over them.
import "./ui/theme.css"
import "./ui/utilities.css"
import "./theme.css"
import "./page.css"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { createAppController } from "./app-controller"

let root = document.querySelector<HTMLDivElement>("#app")
if (!root)
    throw new Error("Laneway root element was not found.")

let controller = createAppController(window.laneway)
void controller.start()
createRoot(root).render(<App api={window.laneway} controller={controller} />)
