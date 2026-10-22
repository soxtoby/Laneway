import type { RepositoryDescriptor } from "@laneway/git"
import type { PublishActionResult, PublishProgress, PublishRequest } from "@laneway/shared"
import { runEngineCommand } from "./engine"

/**
 * Runs one `lane publish --request`. Anything left unpublished (blocked, partial, stale, or failed) exits with
 * status 1 while still reporting its result, so the result is what counts, not the exit status.
 */
export async function runPublish(
    enginePath: string,
    repository: Pick<RepositoryDescriptor, "mainWorktree" | "git">,
    request: PublishRequest,
    onProgress?: (progress: Omit<PublishProgress, "repositoryId">) => void,
): Promise<PublishActionResult> {
    let output = await runEngineCommand({
        enginePath,
        cwd: repository.mainWorktree,
        args: ["publish", "--request", JSON.stringify(request), "--git-path", repository.git.path],
        onMessage: message => {
            if (message.type == "progress")
                onProgress?.({ message: message.message, completed: message.completed, total: message.total })
        },
    }).result
    let result = output.messages.find(message => message.type == "result" && message.command == "publish")
    if (result?.type != "result" || result.command != "publish")
        throw new Error(output.messages.find(message => message.type == "error")?.message ?? (output.diagnostics || "Publish failed."))
    return { ok: true, result }
}
