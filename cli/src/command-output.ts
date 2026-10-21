import type { EngineMessage, LocalPreview } from "@laneway/shared"

export function writeCommandResult(result: EngineMessage, json: boolean) {
    if (json) {
        console.log(JSON.stringify(result))
        if (result.type == "result" && result.command == "git" && result.stderr)
            process.stderr.write(result.stderr)
    } else if (result.type == "result") {
        if (result.command == "git") {
            if (result.stdout)
                process.stdout.write(result.stdout)
            if (result.stderr)
                process.stderr.write(result.stderr)
        } else if (result.command == "local" || result.command == "local-preview") {
            if (result.preview)
                writePreview(result.preview)
            else
                console.log(result.message ?? (result.status == "performed" ? "Done." : result.status))
        } else if (result.command == "conflict") {
            for (let conflict of result.conflicts)
                console.log(`${conflict.id}  ${conflict.branch}  ${conflict.title} (${conflict.files} file(s))`)
            for (let recovery of result.recovery)
                console.log(`Stack ${recovery.stack}: ${recovery.message}`)
            if (result.view) {
                console.log(result.view.ready ? "Ready to accept." : "Resolution required.")
                for (let file of result.view.files) {
                    console.log(`${file.resolved ? "resolved" : "unresolved"} ${file.path}`)
                    if (file.diff)
                        console.log(file.diff)
                }
            } else if (!result.conflicts.length && !result.recovery.length) {
                console.log("No unresolved conflicts.")
            }
            if (result.publishable != undefined)
                console.log(result.publishable ? "Branches may publish." : "Resolve conflicts before publishing.")
        } else if (result.command == "worktree-list") {
            for (let worktree of result.worktrees) {
                let state = [worktree.missing ? "missing" : "", worktree.locked ? "locked" : ""].filter(Boolean).join(", ")
                console.log(`${worktree.path}  ${worktree.branchRef?.replace(/^refs\/heads\//, "") ?? worktree.head}${state ? ` (${state})` : ""}`)
            }
        } else if (result.command == "history") {
            if (!result.entries.length)
                console.log("No Laneway Operations.")
            for (let entry of result.entries)
                console.log(`${entry.isNextUndo ? "undo" : entry.isNextRedo ? "redo" : entry.state} ${entry.id} ${entry.summary}`)
        } else if (result.command == "undo" || result.command == "redo")
            console.log(result.status == "performed" ? result.operation?.summary : `Nothing to ${result.command}.`)
        else if (result.command == "worktree" || result.command == "test-mutation")
            console.log(result.operation.summary)
        else if (result.command == "recovery-status") {
            if (!result.worktrees.length)
                console.log("No worktree recovery required.")
            for (let worktree of result.worktrees)
                console.log(`${worktree.operationId} ${worktree.path}: ${worktree.message}`)
        } else if (result.command == "recover") {
            console.log(result.status == "clean" ? "No recovery is required." : `Recovered ${result.recovered.length} operation(s).`)
            if (result.backupPath)
                console.log(`Remaining files preserved at ${result.backupPath}`)
        } else if (result.command == "edit") {
            if (result.message)
                console.log(result.message)
            else if (!result.sessions.length)
                console.log("No Historical Edits.")
            for (let edit of result.message ? [] : result.sessions) {
                let reason = edit.reason ? `: ${edit.reason}` : ""
                console.log(`${edit.state} ${edit.path} editing ${edit.commit.slice(0, 12)} from ${edit.branch.slice(11)}${reason}`)
            }
        } else if (result.command == "pull") {
            console.log(result.message)
            for (let fetch of result.fetches)
                console.log(`fetch ${fetch.remote} ${fetch.status}${fetch.message ? ` ${fetch.message}` : ""}`)
            for (let stack of result.stacks)
                console.log(`${stack.status} ${stack.branches.join(" > ")}${stack.message ? ` ${stack.message}` : ""}`)
        } else if ("message" in result) {
            console.log(result.message)
        }
    } else if ("message" in result) {
        console.log(result.message)
    }
}

function writePreview(preview: LocalPreview) {
    let composition = preview.composition
    if (composition?.noop)
        console.log("No changes.")
    else {
        console.log(`Affected worktrees: ${preview.affected.join(", ") || "none"}`)
        if (composition) {
            console.log(`Branches: ${composition.branches.join(", ") || "none"}`)
            if (composition.published.length)
                console.log(`Published history: ${composition.published.join(", ")}`)
            if (composition.removed.length)
                console.log(`Commits removed: ${composition.removed.join(", ")}`)
            for (let conflict of composition.conflicts)
                console.log(`Conflict ${conflict.subject}: ${conflict.files.join(", ")}`)
            for (let commit of composition.commits ?? [])
                console.log(`${commit.objectId.slice(0, 12)} ${commit.subject}`)
        }
    }
}
