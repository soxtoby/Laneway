/** A message shown at the edge of the window, such as a confirmation or a failure. */
export interface Notice {
    code: string
    message: string
    /** Confirmations close themselves; failures and guidance wait for the user. */
    transient?: boolean
    /** How long a transient notice stays when it needs longer than the default, such as an undo window. */
    duration?: number
    /** One follow-up the notice offers, such as undoing what it reports. */
    action?: { label: string; run(): void }
    /** Called once the notice leaves the screen, whether dismissed, timed out, or replaced. */
    closed?(): void
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
