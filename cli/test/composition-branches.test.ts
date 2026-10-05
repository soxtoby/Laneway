import { connectRepository } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { createCompositionFixtures, git, perform, preview, request } from "./composition-fixture"

let { fixture, cleanup } = createCompositionFixtures()
afterEach(cleanup)

test("seams on either side of a branch boundary retain their explicit owner", async () => {
    for (let owner of ["feature", "child"]) {
        let { path, base } = await fixture()
        await writeFile(join(path, "feature.txt"), "feature\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "feature")
        let feature = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "child")
        await writeFile(join(path, "child.txt"), "child\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "child")
        await writeFile(join(path, "new.txt"), "new\n")
        await perform(
            path,
            request({
                source: { kind: "working", worktreePath: path },
                target: { kind: "seam", branch: owner, parentId: feature },
                files: [{ path: "new.txt" }],
            }),
        )

        expect(git(path, "rev-parse", "feature") == feature).toBe(owner == "child")
        expect(git(path, "show", "child:new.txt")).toBe("new")
        expect(git(path, "rev-parse", "main")).toBe(base)
    }
}, 120_000)

test("the seam at Primary Branch's tip can prepend a local branch without rewriting Primary", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "feature.txt"), "feature\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "feature")
    await writeFile(join(path, "new.txt"), "new\n")
    await perform(
        path,
        request({ source: { kind: "working", worktreePath: path }, target: { kind: "seam", branch: "feature", parentId: base }, files: [{ path: "new.txt" }] }),
    )

    expect(git(path, "log", "--format=%s", "main..feature")).toBe("feature\nComposed")
    expect(git(path, "rev-parse", "main")).toBe(base)
}, 120_000)

test("branch rebase restacks descendants by default and can leave them on old history", async () => {
    for (let descendants of [true, false]) {
        let { path, base } = await fixture()
        await writeFile(join(path, "feature.txt"), "feature\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "feature")
        let feature = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "child")
        await writeFile(join(path, "child.txt"), "child\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "child")
        let child = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "destination", base)
        await writeFile(join(path, "destination.txt"), "destination\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "destination")
        let destination = git(path, "rev-parse", "HEAD")
        let r = request({
            source: { kind: "branch", branch: "feature", tip: feature },
            target: { kind: "branch", branch: "destination", tip: destination },
            descendants,
        })
        await perform(path, r)

        expect(git(path, "rev-parse", "feature^1")).toBe(destination)
        expect(git(path, "rev-parse", "child") == child).toBe(!descendants)
        expect(git(path, "rev-parse", "destination")).toBe(destination)
    }
}, 120_000)

test("branch rebase takes only commits since its Base, and repeating it changes nothing", async () => {
    let { path, base } = await fixture()
    let commit = async (name: string) => {
        await writeFile(join(path, `${name}.txt`), `${name}\n`)
        git(path, "add", ".")
        git(path, "commit", "-qm", name)
        return git(path, "rev-parse", "HEAD")
    }
    git(path, "checkout", "-qb", "lower", base)
    let lower = await commit("lower")
    git(path, "checkout", "-q", "feature")
    git(path, "reset", "-q", "--hard", lower)
    await commit("first")
    let feature = await commit("second")
    git(path, "checkout", "-qb", "child")
    await commit("child")
    git(path, "checkout", "-qb", "destination", base)
    let destination = await commit("destination")
    git(path, "checkout", "-q", "feature")
    let r = request({
        source: { kind: "branch", branch: "feature", tip: feature },
        target: { kind: "branch", branch: "destination", tip: destination },
    })
    let reviewed = (await preview(path, r)).composition!

    expect(reviewed.commits?.map(c => c.subject)).toEqual(["first", "second"])
    expect(reviewed.branches.sort()).toEqual(["child", "feature"])

    await perform(path, r)

    expect(git(path, "log", "--format=%s", "destination..feature")).toBe("second\nfirst")
    expect(git(path, "log", "--format=%s", "destination..child")).toBe("child\nsecond\nfirst")
    expect(git(path, "rev-parse", "lower")).toBe(lower)
    expect(git(path, "rev-parse", "HEAD")).toBe(git(path, "rev-parse", "feature"))

    let again = request({ ...r, source: { kind: "branch", branch: "feature", tip: git(path, "rev-parse", "feature") } })
    let history = await executeOperationCommand({ command: "history", noWait: false }, path)

    expect((await preview(path, again)).composition?.noop).toBe(true)
    expect((await perform(path, again)).message).toBe("feature is already on top of destination.")
    expect(await executeOperationCommand({ command: "history", noWait: false }, path)).toEqual(history)
    await expect(preview(
        path,
        request({
            source: { kind: "branch", branch: "feature", tip: git(path, "rev-parse", "feature") },
            target: { kind: "branch", branch: "child", tip: git(path, "rev-parse", "child") },
        }),
    )).rejects.toThrow("child already contains feature.")
}, 120_000)

test("branch rebase accepts an ambiguous Base whose candidates agree, and a remote-only destination", async () => {
    let { path, base } = await fixture()
    let commit = async (name: string) => {
        await writeFile(join(path, `${name}.txt`), `${name}\n`)
        git(path, "add", ".")
        git(path, "commit", "-qm", name)
        return git(path, "rev-parse", "HEAD")
    }
    let shared = await commit("shared")
    // Siblings whose upstreams hold the shared fork both stay candidates for the branch beside them.
    for (let name of ["left", "right"]) {
        git(path, "checkout", "-qb", name, shared)
        await commit(name)
        git(path, "update-ref", `refs/remotes/origin/${name}`, shared)
        git(path, "config", `branch.${name}.remote`, "origin")
        git(path, "config", `branch.${name}.merge`, `refs/heads/${name}`)
    }
    git(path, "checkout", "-qb", "teammate", base)
    let teammate = await commit("teammate")
    git(path, "update-ref", "refs/remotes/origin/teammate", teammate)
    git(path, "checkout", "-q", "left")
    git(path, "branch", "-D", "teammate")
    git(path, "checkout", "-q", "feature")
    let feature = await commit("feature")
    let repo = await connectRepository(path)
    let graph = await repo.startReadBranchGraph({ authorIdentities: { secondary: [] }, remotePatterns: [], selectedRemote: "origin" }).result

    expect(graph.branches.find(b => b.name == "feature")?.base.status).toBe("ambiguous")

    await perform(
        path,
        request({
            source: { kind: "branch", branch: "feature", tip: feature },
            target: { kind: "branch", branch: "refs/remotes/origin/teammate", tip: teammate },
        }),
    )

    expect(git(path, "log", "--format=%s", `${base}..feature`)).toBe("feature\nteammate")
    expect(git(path, "rev-parse", "refs/remotes/origin/teammate")).toBe(teammate)
}, 120_000)

test("copy reports partly duplicated files and moving published Primary history is reported for confirmation", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "first")
    let first = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination")
    await writeFile(join(path, "last.txt"), "last\n")
    git(path, "add", ".")
    git(path, "commit", "--amend", "--no-edit", "-q")
    let source = git(path, "rev-parse", "HEAD")
    let r = request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "branch", branch: "destination", tip: first } })

    expect((await preview(path, r)).composition?.skipped).toEqual(["first.txt"])

    await perform(path, r)
    git(path, "branch", "-f", "main", source)
    git(path, "update-ref", "refs/remotes/origin/main", source)
    let move = { ...r, mode: "move" as const, target: { kind: "branch" as const, branch: "destination", tip: git(path, "rev-parse", "destination") } }

    expect((await preview(path, move)).composition?.published).toEqual(["main"])

    await perform(path, move)

    expect(git(path, "log", "--format=%s", "origin/main..main")).toBe("")
    expect(git(path, "rev-parse", "main")).toBe(base)
    expect(git(path, "rev-parse", "origin/main")).toBe(source)
}, 120_000)

test("published Primary history can be combined and reordered once the rewrite is confirmed", async () => {
    let { path, base } = await fixture()
    git(path, "checkout", "-q", "main")
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "first")
    let first = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "second.txt"), "second\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "second")
    let second = git(path, "rev-parse", "HEAD")
    git(path, "update-ref", "refs/remotes/origin/main", second)
    let squash = request({ source: { kind: "commit", objectId: second, branch: "main" }, target: { kind: "commit", branch: "main", objectId: first } })

    expect((await preview(path, squash)).composition).toMatchObject({ published: ["main"], removed: [], conflicts: [] })

    await perform(path, squash)

    expect(git(path, "log", "--format=%s", `${base}..main`)).toBe("first")
    expect(git(path, "log", "--format=%B", "-1", "main").trim()).toBe("first\n\nsecond")
    expect(git(path, "ls-tree", "--name-only", "main")).toBe("a.txt\nfirst.txt\nsecond.txt")
    expect(git(path, "rev-parse", "origin/main")).toBe(second)

    await writeFile(join(path, "seam.txt"), "seam\n")
    let insert = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "main", parentId: base },
        files: [{ path: "seam.txt" }],
    })

    expect((await preview(path, insert)).composition?.published).toEqual(["main"])

    await perform(path, insert)

    expect(git(path, "log", "--format=%s", `${base}..main`)).toBe("first\nComposed")
    expect(git(path, "rev-parse", "origin/main")).toBe(second)
}, 120_000)

test("unpublished commits on the local Primary Branch remain editable", async () => {
    let { path, base } = await fixture()
    git(path, "checkout", "-q", "main")
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "first")
    let first = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "second.txt"), "second\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "second")
    await writeFile(join(path, "extra.txt"), "extra\n")
    await perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "commit", branch: "main", objectId: first },
            files: [{ path: "extra.txt" }],
        }),
    )

    expect(git(path, "log", "--format=%s", "origin/main..main")).toBe("second\nfirst")
    expect(git(path, "ls-tree", "--name-only", "main~1")).toBe("a.txt\nextra.txt\nfirst.txt")

    await writeFile(join(path, "seam.txt"), "seam\n")
    await perform(
        path,
        request({ source: { kind: "working", worktreePath: path }, target: { kind: "seam", branch: "main", parentId: base }, files: [{ path: "seam.txt" }] }),
    )

    expect(git(path, "log", "--format=%s", "origin/main..main")).toBe("second\nfirst\nComposed")
    expect(git(path, "rev-parse", "origin/main")).toBe(base)
}, 120_000)
