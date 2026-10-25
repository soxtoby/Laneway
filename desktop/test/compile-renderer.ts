// Runs the renderer through the React Compiler, as the build does, so the tests exercise what ships.
import { plugin } from "bun"
import { reactCompiler } from "../react-compiler"

plugin(reactCompiler)
