import type { RepositoryGit } from "@laneway/git"
import { type PublishReceipt, PublishReceiptSchema } from "@laneway/shared"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

// Receipts are small, but each plan reads them all, so only the newest are kept.
let retainedReceipts = 100

// Identifiers sort by creation time, so the newest receipt is the last file name.
export function receiptId() {
    return `${new Date().toISOString().replace(/[-:.Z]/g, "")}-${crypto.randomUUID().slice(0, 4)}`
}

export async function saveReceipt(repo: RepositoryGit, receipt: PublishReceipt) {
    let directory = receiptDirectory(repo)
    await mkdir(directory, { recursive: true })
    let path = join(directory, `${receipt.id}.json`)
    await writeFile(`${path}.tmp`, JSON.stringify(receipt))
    await rename(`${path}.tmp`, path)

    let names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort()
    for (let name of names.slice(0, -retainedReceipts))
        await rm(join(directory, name), { force: true })
}

export async function readReceipt(repo: RepositoryGit, id: string) {
    return /^[\w-]+$/.test(id) ? parseReceipt(join(receiptDirectory(repo), `${id}.json`)) : undefined
}

// The newest receipt that published, or tried to publish, any of these branches.
export async function latestReceipt(repo: RepositoryGit, branches: string[]) {
    let names = await readdir(receiptDirectory(repo)).catch(() => [] as string[])
    let receipts = await Promise.all(
        names.filter(name => name.endsWith(".json")).sort().reverse().map(name => parseReceipt(join(receiptDirectory(repo), name))),
    )
    return receipts.find(receipt => receipt?.updates.some(update => branches.includes(update.branch)))
}

async function parseReceipt(path: string) {
    try {
        return PublishReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")))
    } catch {
        // A missing or damaged receipt loses Resume and restoration, never branches.
        return undefined
    }
}

function receiptDirectory(repo: RepositoryGit) {
    return join(repo.descriptor.commonDirectory, "laneway", "publish")
}
