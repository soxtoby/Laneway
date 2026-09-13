// THROWAWAY: inject three commit composers into the real renderer using fixture data only.
import { join } from "node:path"

const root = join(import.meta.dir, "src/renderer")
const output = join(import.meta.dir, "out/commit-prototype")
const build = await Bun.build({
    entrypoints: [join(root, "src/commit-prototype-entry.tsx")],
    outdir: output,
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [{
        name: "throwaway-composer-host",
        setup(builder) {
            builder.onLoad({ filter: /[\\/]inspection\.tsx$/ }, async args => {
                const source = await Bun.file(args.path).text()
                const start = source.indexOf("{state.worktreePath && (")
                const end = source.indexOf("{!state.worktreePath && column.kind", start)
                if (start < 0 || end < 0)
                    throw new Error("Working Changes prototype host moved.")
                return {
                    contents: 'import { CommitPrototype } from "./commit-prototype"\n'
                        + source.slice(0, start) + "{state.worktreePath && <CommitPrototype />}\n" + source.slice(end),
                    loader: "tsx",
                }
            })
        },
    }],
})
if (!build.success)
    throw new AggregateError(build.logs, "Prototype build failed")
await Bun.write(join(output, "styles.css"), Bun.file(join(root, "src/styles.css")))
await Bun.write(
    join(output, "index.html"),
    (await Bun.file(join(root, "index.html")).text())
        .replace("./src/styles.css", "./styles.css")
        .replace("./src/main.tsx", "./commit-prototype-entry.js"),
)
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 4315,
    fetch(request) {
        const path = new URL(request.url).pathname
        const name = path == "/" ? "index.html" : path.slice(1)
        if (!["index.html", "styles.css", "commit-prototype-entry.js"].includes(name))
            return new Response("Not found", { status: 404 })
        return new Response(Bun.file(join(output, name)))
    },
})
console.log(`Commit prototype: ${server.url}?variant=A — simulated Git, memory-only state`)
