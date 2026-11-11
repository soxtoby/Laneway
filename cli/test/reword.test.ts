import type { LocalRequest, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { createCompositionFixtures, git, perform, preview } from "./composition-fixture"

let { fixture, cleanup } = createCompositionFixtures()
afterEach(cleanup)

test("rewording keeps the commit's tree and author, restacks its dependents, and undoes as one operation", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "feature.txt"), "feature\n")
    git(path, "add", ".")
    git(path, "-c", "user.name=Original Author", "-c", "user.email=original@example.invalid", "commit", "-qm", "feature", "-m", "Old body")
    let feature = git(path, "rev-parse", "HEAD")
    let tree = git(path, "rev-parse", "HEAD^{tree}")
    git(path, "checkout", "-qb", "child")
    await writeFile(join(path, "child.txt"), "child\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "child")
    let child = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "a.txt"), "dirty\n")
    let request: LocalRequest = { action: "reword", objectId: feature, branch: "feature", title: "Renamed feature", message: "New body  \n\n\n" }

    let reviewed = await preview(path, request)
    expect(reviewed.composition).toMatchObject({ published: [], removed: [], conflicts: [], noop: false })
    expect(reviewed.composition?.branches.toSorted()).toEqual(["child", "feature"])
    // Nothing needs a decision, so one engine invocation reviews and applies the reword.
    let applied = await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path) as LocalResult
    expect(applied).toMatchObject({ status: "performed", message: "Commit reworded." })

    let reworded = git(path, "rev-parse", "feature")
    expect(reworded).not.toBe(feature)
    expect(git(path, "log", "-1", "--format=%B", "feature")).toBe("Renamed feature\n\nNew body")
    expect(git(path, "log", "-1", "--format=%an <%ae>", "feature")).toBe("Original Author <original@example.invalid>")
    expect(git(path, "rev-parse", "feature^{tree}")).toBe(tree)
    expect(git(path, "rev-parse", "feature^")).toBe(base)
    expect(git(path, "rev-parse", "child^")).toBe(reworded)
    expect(git(path, "log", "-1", "--format=%s", "child")).toBe("child")
    expect(git(path, "rev-parse", "child^{tree}")).toBe(git(path, "rev-parse", `${child}^{tree}`))
    expect(git(path, "branch", "--show-current")).toBe("child")
    expect(git(path, "status", "--porcelain")).toBe("M a.txt")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("dirty\n")
    expect(git(path, "rev-parse", "main")).toBe(base)

    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect(git(path, "rev-parse", "feature")).toBe(feature)
    expect(git(path, "rev-parse", "child")).toBe(child)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("dirty\n")

    await executeOperationCommand({ command: "redo", noWait: false }, path)

    expect(git(path, "rev-parse", "feature")).toBe(reworded)
    expect(git(path, "rev-parse", "child^")).toBe(reworded)
}, 60_000)

test("unchanged messages, published history, and uneditable commits are reported before any rewrite", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "feature.txt"), "feature\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "feature", "-m", "Body")
    let feature = git(path, "rev-parse", "HEAD")
    let operations = async () => (await executeOperationCommand({ command: "history", noWait: false }, path) as { entries: unknown[] }).entries.length
    let recorded = await operations()

    // The same message rewrites nothing and records no operation.
    let same = await perform(path, { action: "reword", objectId: feature, branch: "feature", title: "feature", message: "Body" })

    expect(same.message).toBe("The commit message is unchanged.")
    expect(git(path, "rev-parse", "feature")).toBe(feature)
    expect(await operations()).toBe(recorded)

    git(path, "update-ref", "refs/remotes/origin/feature", feature)
    git(path, "config", "branch.feature.remote", "origin")
    git(path, "config", "branch.feature.merge", "refs/heads/feature")
    let request: LocalRequest = { action: "reword", objectId: feature, branch: "feature", title: "Published feature", message: "" }

    // Published history waits for confirmation: the one-call path answers with a preview instead of rewriting.
    let reviewed = await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path) as LocalResult
    expect(reviewed.status).toBe("preview")
    expect(reviewed.preview?.composition?.published).toEqual(["feature"])
    expect(git(path, "rev-parse", "feature")).toBe(feature)
    let confirmed = await executeOperationCommand({ command: "local", request, token: reviewed.preview!.token, noWait: false }, path) as LocalResult
    expect(confirmed.status).toBe("performed")
    expect(git(path, "log", "-1", "--format=%s", "feature")).toBe("Published feature")
    await executeOperationCommand({ command: "undo", noWait: false }, path)
    expect(git(path, "rev-parse", "feature")).toBe(feature)
    await expect(preview(path, { ...request, objectId: base, branch: "main" })).rejects.toThrow("root or merge")
    await expect(preview(path, { ...request, branch: "main" })).rejects.toThrow("not in the selected branch")
}, 60_000)
