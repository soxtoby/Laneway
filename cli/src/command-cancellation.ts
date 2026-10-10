export function monitorCancellation(readStdin = true) {
    let cancelled = false
    let notifyWaiter: (() => void) | undefined
    let reader = readStdin ? Bun.stdin.stream().getReader() : undefined
    let cancel = () => {
        cancelled = true
        notifyWaiter?.()
    }
    process.on("SIGINT", cancel)
    process.on("SIGTERM", cancel)
    if (reader)
        void readControls(reader, cancel).catch(() => {})

    return {
        isCancelled: () => cancelled,
        async wait(delayMs: number) {
            if (cancelled)
                return true
            return new Promise<boolean>(resolveWait => {
                let timer = setTimeout(() => {
                    notifyWaiter = undefined
                    resolveWait(false)
                }, delayMs)
                notifyWaiter = () => {
                    clearTimeout(timer)
                    notifyWaiter = undefined
                    resolveWait(true)
                }
            })
        },
        dispose() {
            process.off("SIGINT", cancel)
            process.off("SIGTERM", cancel)
            void reader?.cancel()
        },
    }
}

async function readControls(reader: ReadableStreamDefaultReader<Uint8Array>, cancel: () => void) {
    let decoder = new TextDecoder()
    let buffer = ""
    let done = false
    while (!done) {
        let chunk = await reader.read()
        done = chunk.done
        if (chunk.value) {
            buffer += decoder.decode(chunk.value, { stream: true })
            let lines = buffer.split("\n")
            buffer = lines.pop()!
            if (lines.some(line => line.trim() == "cancel")) {
                cancel()
                done = true
            }
        }
    }
}
