import type { BunPlugin } from "bun"
import { mkdirSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Outside the repository, so the development server never sees its writes.
let cache = join(tmpdir(), "laneway-react-compiler")

/**
 * Compiles each of the renderer's components with Bun's React Compiler before it loads, for the development server and
 * the tests, which load modules one at a time; the build compiles its whole bundle with `reactCompiler`. Compiled
 * modules are cached by their source, so only changed ones compile again.
 */
export let reactCompiler: BunPlugin = {
    name: "react-compiler",
    setup(build) {
        build.onLoad({ filter: /[\\/]desktop[\\/]src[\\/]renderer[\\/].*\.tsx$/ }, async ({ path }) => {
            let source = await Bun.file(path).text()
            let cached = join(cache, `${Bun.hash(`${Bun.version}:${path}:${source}`).toString(36)}.js`)
            if (await Bun.file(cached).exists())
                return { contents: await Bun.file(cached).text(), loader: "tsx" }
            // Every import stays as written, so the module compiles alone and its imports load as usual.
            let result = await Bun.build({
                entrypoints: [path],
                target: "browser",
                external: ["*"],
                sourcemap: "inline",
                reactCompiler: true,
                jsx: { development: true },
            })
            if (!result.success)
                throw new AggregateError(result.logs, `The React Compiler couldn't compile ${path}`)
            let contents = await result.outputs[0]!.text()
            // Test processes run in parallel, so a module appears in the cache whole or not at all.
            mkdirSync(cache, { recursive: true })
            let written = `${cached}.${process.pid}`
            await Bun.write(written, contents)
            try {
                renameSync(written, cached)
            } catch {
                // Another process cached it first, with the same contents.
                rmSync(written, { force: true })
            }
            return { contents, loader: "tsx" }
        })
    },
}

export default reactCompiler
