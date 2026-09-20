import type { CommitDraft } from "@laneway/shared"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export class CommitDrafts {
    private pending: Promise<unknown> = Promise.resolve()
    constructor(private readonly path: string) {}
    async read(repository: string, worktree: string): Promise<CommitDraft> {
        await this.pending
        return (await this.load())[JSON.stringify([repository, worktree])] ?? { title: "", message: "", branch: "" }
    }
    write(repository: string, worktree: string, draft: CommitDraft) {
        const task = this.pending.then(async () => {
            const data = await this.load()
            const key = JSON.stringify([repository, worktree])
            if (!draft.title && !draft.message && !draft.branch)
                delete data[key]
            else
                data[key] = draft
            await mkdir(dirname(this.path), { recursive: true })
            const temporary = `${this.path}.tmp`
            await writeFile(temporary, JSON.stringify(data))
            await rename(temporary, this.path)
        })
        this.pending = task.catch(() => {})
        return task
    }
    private async load(): Promise<Record<string, CommitDraft>> {
        try {
            return JSON.parse(await readFile(this.path, "utf8"))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code == "ENOENT")
                return {}
            throw error
        }
    }
}
