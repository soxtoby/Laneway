import type { RepositoryGit } from "@laneway/git"
import { type PublishReceipt, PublishReceiptSchema } from "@laneway/shared"
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { releaseRecoveryObjects, retainRecoveryObjects } from "./operations/recovery-objects"

// Runs work under the repository mutation lock, which covers every change to retained objects.
export type MutationLock = <T>(work: () => Promise<T>) => Promise<T>

// Receipts are small, but each plan reads them all, so only the newest finished ones are kept.
let retainedReceipts = 100

// Identifiers sort by creation time, so the newest receipt is the last file name.
export function receiptId() {
    return `${new Date().toISOString().replace(/[-:.Z]/g, "")}-${crypto.randomUUID().slice(0, 4)}`
}

// Saves the receipt and retains the commits it names, so Resume and restoration outlive reflog expiry.
// Retention shares Operation History's protected packs; pruning a receipt releases its commits. The receipt
// being pushed, and the one it restores, are never pruned here; a concurrent publish could still prune an old
// receipt being resumed, which takes two publishes at once in a repository with 100 newer finished receipts.
export async function openReceipt(repo: RepositoryGit, receipt: PublishReceipt, lock: MutationLock) {
    await saveReceipt(repo, receipt)
    let objects = receipt.updates.flatMap(update => [update.expected, update.target]).filter((object): object is string => object != null)
    await lock(async () => {
        await retainRecoveryObjects(repo, retentionKey(receipt.id), objects)
        for (let id of await prunable(repo, [receipt.id, receipt.restores])) {
            await rm(receiptPath(repo, id), { force: true })
            await releaseRecoveryObjects(repo, retentionKey(id))
        }
    })
}

// Written durably before any push, so a machine crash cannot lose the intent of a publish that reached the remote.
export async function saveReceipt(repo: RepositoryGit, receipt: PublishReceipt) {
    let path = receiptPath(repo, receipt.id)
    await mkdir(receiptDirectory(repo), { recursive: true })
    let file = await open(`${path}.tmp`, "w")
    try {
        await file.writeFile(JSON.stringify(receipt))
        await file.sync()
    } finally {
        await file.close()
    }
    await rename(`${path}.tmp`, path)
}

export async function readReceipt(repo: RepositoryGit, id: string) {
    return /^[\w-]+$/.test(id) ? parseReceipt(repo, id) : undefined
}

// The newest receipt that published, or tried to publish, any of these branches.
export async function latestReceipt(repo: RepositoryGit, branches: string[]) {
    let receipts = await readReceipts(repo)
    return receipts.map(([, receipt]) => receipt).findLast(receipt => receipt?.updates.some(update => branches.includes(update.branch)))
}

// The cap never drops a receipt Resume may still need: one whose remote may hold some of its updates but not
// others, or whose attempt stopped before Git answered. A damaged receipt has nothing left to lose.
async function prunable(repo: RepositoryGit, active: Array<string | undefined>) {
    let finished = (await readReceipts(repo)).filter(([id, receipt]) => !active.includes(id) && (!receipt || !resumable(receipt))).map(([id]) => id)
    return finished.slice(0, -retainedReceipts)
}

function resumable(receipt: PublishReceipt) {
    let statuses = new Set(receipt.updates.map(update => update.status))
    let interrupted = statuses.has("pending") && !statuses.has("stale") && !statuses.has("failed")
    return interrupted || statuses.has("published") && statuses.size > 1
}

async function readReceipts(repo: RepositoryGit) {
    let names = await readdir(receiptDirectory(repo)).catch(() => [] as string[])
    let ids = names.filter(name => /^[\w-]+\.json$/.test(name)).map(name => name.slice(0, -5)).sort()
    return Promise.all(ids.map(async id => [id, await parseReceipt(repo, id)] as const))
}

async function parseReceipt(repo: RepositoryGit, id: string) {
    try {
        let receipt = PublishReceiptSchema.parse(JSON.parse(await readFile(receiptPath(repo, id), "utf8")))
        // Its id names the file it is rewritten to, so it must be the file's own name.
        return receipt.id == id ? receipt : undefined
    } catch {
        // A missing or damaged receipt loses Resume and restoration, never branches.
        return undefined
    }
}

// Identifiers are word characters and hyphens only, so every receipt path stays inside the receipt directory.
function receiptPath(repo: RepositoryGit, id: string) {
    if (!/^[\w-]+$/.test(id))
        throw new Error(`${id} is not a Publish Receipt identifier.`)
    return join(receiptDirectory(repo), `${id}.json`)
}

function receiptDirectory(repo: RepositoryGit) {
    return join(repo.descriptor.commonDirectory, "laneway", "publish")
}

function retentionKey(id: string) {
    return `publish-${id}`
}
