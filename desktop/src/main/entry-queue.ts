interface QueuedEntry<T> {
    run(setCancel: (cancel: (() => void) | undefined) => void): Promise<T>
    resolve(value: T): void
    reject(error: unknown): void
}

export class EntryQueue<T> {
    private readonly pending: QueuedEntry<T>[] = []
    private active = false
    private cancelActive: (() => void) | undefined

    constructor(private readonly cancelledResult: () => T) {}

    enqueue(run: QueuedEntry<T>["run"]): Promise<T> {
        return new Promise((resolve, reject) => {
            this.pending.push({ run, resolve, reject })
            void this.drain()
        })
    }

    cancel() {
        if (!this.cancelActive)
            return false
        this.cancelActive()
        for (const entry of this.pending.splice(0))
            entry.resolve(this.cancelledResult())
        return true
    }

    private async drain() {
        if (this.active)
            return
        const entry = this.pending.shift()
        if (!entry)
            return
        this.active = true
        try {
            entry.resolve(await entry.run(cancel => this.cancelActive = cancel))
        } catch (error) {
            entry.reject(error)
        } finally {
            this.cancelActive = undefined
            this.active = false
            void this.drain()
        }
    }
}
