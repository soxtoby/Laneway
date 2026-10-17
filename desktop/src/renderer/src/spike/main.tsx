/** @jsxImportSource react */
// The starter's variables and utilities load once, before its components and Laneway's theme over them.
import "./ui/theme.css"
import "./ui/utilities.css"
import "./theme.css"
import "./page.css"
import { createRoot } from "react-dom/client"
import { SpikeApp } from "./app"

let app = document.querySelector<HTMLDivElement>("#app")
if (!app)
    throw new Error("Laneway root element was not found.")

createRoot(app).render(<SpikeApp api={window.laneway} />)
