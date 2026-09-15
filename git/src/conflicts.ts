import { type ConflictFile, type ConflictState, ConflictStateSchema, type ConflictSubject, type ResolutionCandidate } from "@git-workbench/shared"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { RepositoryGit } from "./index"

export const conflictStateRef = "refs/workbench/conflicts/current"
export const temporaryBranchPrefix = "refs/heads/git-workbench/unresolved/"
export const gitText = async (repo: RepositoryGit, args: string[], input?: string | Uint8Array, env?: Record<string, string>) =>
    (await repo.command(repo.descriptor.mainWorktree, args, input, env)).toString().trim()
const recoveryIdentity = {
    GIT_AUTHOR_NAME: "Git Workbench",
    GIT_AUTHOR_EMAIL: "recovery@workbench.invalid",
    GIT_COMMITTER_NAME: "Git Workbench",
    GIT_COMMITTER_EMAIL: "recovery@workbench.invalid",
}

export async function readConflictState(repo: RepositoryGit): Promise<ConflictState> {
    const ref = await repo.resolveRef(conflictStateRef)
    if (!ref)
        return { version: 1, stacks: [], working: [], retainedConflicts: [] }
    try {
        return ConflictStateSchema.parse(JSON.parse((await repo.command(repo.descriptor.mainWorktree, ["show", `${ref}:state.json`])).toString()))
    } catch {
        throw new Error("Conflict recovery metadata is damaged. Retained branches and recovery refs have been preserved.")
    }
}

// A recovery commit retains the metadata plus all input, provisional and accepted objects.
// Git GC follows tree entries and parents; object IDs written only inside JSON would not suffice.
export async function storeConflictState(repo: RepositoryGit, state: ConflictState, before: string | null) {
    const objects = new Map<string, string>()
    const parents = new Set<string>()
    for (const retained of state.retainedConflicts) {
        parents.add(retained.commit)
        parents.add(retained.source)
        retainSubject(retained.conflict, objects)
    }
    for (const stack of state.stacks) {
        parents.add(stack.base)
        for (const branch of stack.branches) {
            parents.add(branch.before)
            parents.add(branch.current)
        }
        for (const step of stack.steps) {
            parents.add(step.source)
            parents.add(step.current)
            if (step.accepted)
                objects.set(step.accepted.tree, "tree")
            if (step.conflict)
                retainSubject(step.conflict, objects)
        }
    }
    for (const working of state.working) {
        parents.add(working.head)
        parents.add(working.stash)
        if (working.suspended)
            parents.add(working.suspended)
        retainSubject(working.conflict, objects)
    }
    const after = await retainedDocument(repo, state, objects, [...parents])
    await repo.updateRefs([{ ref: conflictStateRef, before, after }])
    return after
}
function retainSubject(subject: ConflictSubject, objects: Map<string, string>) {
    objects.set(subject.tree, "tree")
    if (subject.suggestion)
        objects.set(subject.suggestion, "tree")
    for (const file of subject.files) {
        for (const entry of [file.base, file.left, file.right, file.provisional]) {
            if (entry && entry.mode != "160000")
                objects.set(entry.object, "blob")
        }
    }
}
export async function retainedDocument(repo: RepositoryGit, value: unknown, objects: Map<string, string>, parents: string[] = []) {
    const metadata = await gitText(repo, ["hash-object", "-w", "--stdin"], JSON.stringify(value))
    const entries = [`100644 blob ${metadata}\tstate.json\0`]
    for (const [object, type] of objects)
        entries.push(`${type == "tree" ? "040000" : "100644"} ${type} ${object}\t${object}\0`)
    const tree = await gitText(repo, ["mktree", "-z"], entries.join(""))
    return gitText(repo, ["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent])], "Workbench conflict recovery\n", recoveryIdentity)
}

export async function withConflictScratch<T>(action: (path: string) => Promise<T>) {
    const root = resolve(tmpdir())
    const path = await mkdtemp(join(root, "workbench-conflict-"))
    try {
        return await action(path)
    } finally {
        if (!resolve(path).startsWith(root + sep))
            throw new Error("Invalid conflict scratch path")
        await rm(path, { recursive: true, force: true })
    }
}

export async function treeEntries(repo: RepositoryGit, tree: string) {
    const result = new Map<string, NonNullable<ConflictFile["base"]>>()
    const records = (await repo.command(repo.descriptor.mainWorktree, ["ls-tree", "-r", "-z", tree])).toString().split("\0").filter(Boolean)
    for (const record of records) {
        const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record)!
        result.set(match[3], { mode: match[1], object: match[2] })
    }
    return result
}
export async function replaceTreeFiles(repo: RepositoryGit, tree: string, files: Record<string, ConflictFile["base"]>) {
    return withConflictScratch(async path => {
        const env = { GIT_INDEX_FILE: join(path, "index") }
        await gitText(repo, ["read-tree", tree], undefined, env)
        const zero = "0".repeat(repo.descriptor.objectFormat == "sha1" ? 40 : 64)
        const changes = Object.entries(files).map(([name, entry]) => entry ? `${entry.mode} ${entry.object}\t${name}\0` : `0 ${zero}\t${name}\0`).join("")
        if (changes)
            await gitText(repo, ["update-index", "-z", "--index-info"], changes, env)
        return gitText(repo, ["write-tree"], undefined, env)
    })
}
export async function blob(repo: RepositoryGit, entry: ConflictFile["base"]) {
    return entry && entry.mode != "160000" ? repo.command(repo.descriptor.mainWorktree, ["cat-file", "blob", entry.object]) : null
}
export function isText(bytes: Buffer | null) {
    return bytes !== null && !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes)
}

export async function replayTree(
    repo: RepositoryGit,
    base: string,
    left: string,
    right: string,
    id: string,
): Promise<{ tree: string; conflict?: ConflictSubject }> {
    const result = await repo.run(repo.descriptor.mainWorktree, [
        "-c",
        "merge.conflictStyle=merge",
        "merge-tree",
        "--write-tree",
        "-z",
        `--merge-base=${base}`,
        left,
        right,
    ])
    if (result.exitCode != 0 && result.exitCode != 1)
        throw new Error(result.stderr.toString() || "Unable to prepare the stack rewrite.")
    const records = result.stdout.toString().split("\0")
    let tree = records.shift()!.trim()
    if (!/^[a-f0-9]{40,64}$/.test(tree))
        throw new Error("Git did not return a provisional tree.")
    if (!result.exitCode)
        return { tree }
    const staged = new Map<string, ConflictFile>()
    for (const record of records) {
        if (!record)
            break
        const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(record)
        if (!match)
            throw new Error("Git returned invalid conflict stages.")
        const file = staged.get(match[4]) ?? { path: match[4], base: null, left: null, right: null, provisional: null, text: false }
        file[match[3] == "1" ? "base" : match[3] == "2" ? "left" : "right"] = { mode: match[1], object: match[2] }
        staged.set(file.path, file)
    }
    if (!staged.size)
        throw new Error("Git reported a structural conflict without recoverable file stages.")
    const existing = await treeEntries(repo, tree)
    const inputs = await Promise.all([treeEntries(repo, base), treeEntries(repo, left), treeEntries(repo, right)])
    const leftLabel = `Updated stack at ${left.slice(0, 8)} (${id.slice(0, 8)})`
    const rightLabel = `Replayed commit ${right.slice(0, 8)} (${id.slice(0, 8)})`
    const replacements: Record<string, ConflictFile["base"]> = {}
    // merge-tree may park a file beside a conflicting directory as path~<commit>.
    // Keep that bookkeeping out of the project and record the real paths instead.
    for (const file of [...staged.values()]) {
        if (inputs.some(input => input.has(file.path)))
            continue
        const original = [...new Set(inputs.flatMap(input => [...input.keys()]))].find(path => file.path.startsWith(path + "~"))
        if (!original)
            continue
        staged.delete(file.path)
        replacements[file.path] = null
        const paths = new Set(inputs.flatMap(input => [...input.keys()].filter(path => path == original || path.startsWith(original + "/"))))
        for (const path of paths) {
            staged.set(path, {
                path,
                base: inputs[0].get(path) ?? null,
                left: inputs[1].get(path) ?? null,
                right: inputs[2].get(path) ?? null,
                provisional: null,
                text: false,
            })
        }
    }
    let markerSize = 7
    for (const file of staged.values()) {
        for (const entry of [file.base, file.left, file.right]) {
            const bytes = await blob(repo, entry)
            for (const match of bytes?.toString().matchAll(/^(<{7,}|={7,}|>{7,})/gm) ?? [])
                markerSize = Math.max(markerSize, match[1].length + 1)
        }
    }
    for (const file of staged.values()) {
        const [baseBytes, leftBytes, rightBytes] = await Promise.all([blob(repo, file.base), blob(repo, file.left), blob(repo, file.right)])
        file.provisional = existing.get(file.path) ?? null
        file.text = Boolean(
            file.left?.mode.startsWith("100") && file.right?.mode.startsWith("100") && isText(leftBytes) && isText(rightBytes)
                && (!baseBytes || isText(baseBytes)),
        )
        if (file.text) {
            const merged = await withConflictScratch(async path => {
                await Promise.all([
                    writeFile(join(path, "BASE"), baseBytes ?? ""),
                    writeFile(join(path, "LEFT"), leftBytes!),
                    writeFile(join(path, "RIGHT"), rightBytes!),
                ])
                const merge = await repo.run(path, [
                    "merge-file",
                    "--stdout",
                    `--marker-size=${markerSize}`,
                    "-L",
                    leftLabel,
                    "-L",
                    "Original base",
                    "-L",
                    rightLabel,
                    "LEFT",
                    "BASE",
                    "RIGHT",
                ])
                if (merge.exitCode < 0 || merge.exitCode > 127)
                    throw new Error(merge.stderr.toString())
                return merge.stdout
            })
            replacements[file.path] = { mode: file.right!.mode, object: await gitText(repo, ["hash-object", "-w", "--stdin"], merged) }
        } else {
            const rightHasDirectory = [...inputs[2].keys()].some(path => path.startsWith(file.path + "/"))
            const rightHasParentFile = [...inputs[2].keys()].some(path => file.path.startsWith(path + "/"))
            replacements[file.path] = rightHasDirectory || rightHasParentFile ? null : file.right ?? file.left ?? file.base
        }
        file.provisional = replacements[file.path]
    }
    tree = await replaceTreeFiles(repo, tree, replacements)
    const files = [...staged.values()]
    const input = createHash("sha256").update(JSON.stringify(files.map(({ path, base, left, right }) => ({ path, base, left, right })))).digest("hex")
    return { tree, conflict: { id, input, tree, leftLabel, rightLabel, markerSize, files } }
}

export async function rewriteCommit(repo: RepositoryGit, source: string, parent: string, tree: string) {
    const raw = (await repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", source])).toString()
    const split = raw.indexOf("\n\n")
    const author = /^author (.*) <([^>]*)> (.+)$/m.exec(raw.slice(0, split))
    if (!author)
        throw new Error("The replayed commit has no author.")
    return gitText(repo, ["commit-tree", tree, "-p", parent], raw.slice(split + 2), {
        GIT_AUTHOR_NAME: author[1],
        GIT_AUTHOR_EMAIL: author[2],
        GIT_AUTHOR_DATE: author[3],
    })
}
export function conflictHunks(content: string, subject: ConflictSubject) {
    const start = `${"<".repeat(subject.markerSize)} ${subject.leftLabel}\n`, end = `${">".repeat(subject.markerSize)} ${subject.rightLabel}`
    const separator = `${"=".repeat(subject.markerSize)}\n`
    const hunks: Array<{ index: number; start: number; end: number; left: string; right: string }> = []
    let offset = 0
    for (;;) {
        const begin = content.indexOf(start, offset)
        if (begin < 0)
            break
        const middle = content.indexOf(separator, begin + start.length)
        const finish = content.indexOf(end, middle + separator.length)
        if (middle < 0 || finish < 0)
            break
        offset = finish + end.length + (content[finish + end.length] == "\n" ? 1 : 0)
        hunks.push({
            index: hunks.length,
            start: begin,
            end: offset,
            left: content.slice(begin + start.length, middle),
            right: content.slice(middle + separator.length, finish),
        })
    }
    return hunks
}
export async function candidateReady(repo: RepositoryGit, subject: ConflictSubject, candidate: ResolutionCandidate) {
    const paths = Object.entries(candidate.files).filter(([, entry]) => entry).map(([path]) => path)
    if (paths.some(path => paths.some(other => other != path && path.startsWith(other + "/"))))
        return false
    for (const file of subject.files) {
        if (!(file.path in candidate.files))
            return false
        const bytes = await blob(repo, candidate.files[file.path])
        if (bytes && new RegExp(`^(?:<{7,} Updated stack at|>{7,} Replayed commit) [a-f0-9]+ \\(${subject.id.slice(0, 8)}\\)`, "m").test(bytes.toString()))
            return false
    }
    return true
}
