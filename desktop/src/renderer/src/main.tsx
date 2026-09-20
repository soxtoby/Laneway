import { createRoot } from "remix/ui"
import { LanewayApp } from "./app"

const app = document.querySelector<HTMLDivElement>("#app")
if (!app)
    throw new Error("Laneway root element was not found.")

const root = createRoot(app)
root.addEventListener("error", event => console.error("Remix renderer failed.", event.error))
root.render(<LanewayApp api={window.laneway} />)
