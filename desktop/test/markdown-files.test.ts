import type { FileDiffPage, FileVersionRequest } from "@laneway/shared"
import { expect, test } from "bun:test"
import { readMarkdownVersions } from "../src/renderer/react/markdown-files"

test("readMarkdownVersions reads a renamed document's old version where each view keeps it", async () => {
    let requests: FileVersionRequest[] = []
    let api = {
        cancelInspection: async () => false,
        readFileVersion: async (_id: string, _requestId: string, request: FileVersionRequest) => {
            requests.push(request)
            return { ok: true as const, content: { state: "ready" as const, bytes: new TextEncoder().encode(`${request.side} ${request.path}`), size: 0 } }
        },
    }
    let page = (view: FileDiffPage["view"]): FileDiffPage => ({
        source: { kind: "working", worktreePath: "C:/work" },
        file: { path: "docs/b.md", oldPath: "docs/a.md", status: "renamed", staged: true, unstaged: true, untracked: false, ignored: false, conflicted: false },
        view,
        version: "one",
        lines: [],
        summary: [],
        selectable: false,
    })

    expect(await readMarkdownVersions(api, "repository", page("combined"), new AbortController().signal)).toEqual({
        old: "old docs/a.md",
        new: "new docs/b.md",
    })
    expect(await readMarkdownVersions(api, "repository", page("unstaged"), new AbortController().signal)).toEqual({
        old: "old docs/b.md",
        new: "new docs/b.md",
    })
    expect(requests.map(request => request.view)).toEqual(["combined", "combined", "unstaged", "unstaged"])
})

test("readMarkdownVersions leaves out a version that doesn't have the document", async () => {
    let api = {
        cancelInspection: async () => false,
        readFileVersion: async (_id: string, _requestId: string, request: FileVersionRequest) =>
            request.side == "old"
                ? { ok: true as const, content: { state: "missing" as const } }
                : { ok: true as const, content: { state: "ready" as const, bytes: new TextEncoder().encode("# New"), size: 5 } },
    }
    let page: FileDiffPage = {
        source: { kind: "working", worktreePath: "C:/work" },
        file: { path: "new.md", status: "added", staged: false, unstaged: false, untracked: true, ignored: false, conflicted: false },
        view: "combined",
        version: "one",
        lines: [],
        summary: [],
        selectable: false,
    }

    expect(await readMarkdownVersions(api, "repository", page, new AbortController().signal)).toEqual({ new: "# New" })
})
