export interface CancellationSignal {
    isCancelled(): boolean
    wait(delayMs: number): Promise<boolean>
}

export class OperationCancelledError extends Error {}

export class OperationRuntimeError extends Error {
    constructor(
        readonly code:
            | "operation.history-corrupt"
            | "operation.internal"
            | "operation.journal-corrupt"
            | "operation.locked"
            | "operation.precondition-failed"
            | "operation.recovery-blocked",
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message)
    }
}
