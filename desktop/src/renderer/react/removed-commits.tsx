import type { CompositionPreview } from "@laneway/shared"

export function RemovedCommits({ preview }: { preview?: CompositionPreview }) {
    if (!preview?.removed.length)
        return null
    let count = preview.removed.length
    return (
        <div>
            <p>{count == 1 ? "Removes 1 empty commit" : `Removes ${count} empty commits`}</p>
            {preview.removedSubjects && <ul>{preview.removed.map(id => <li key={id}>{preview.removedSubjects?.[id] || "Untitled commit"}</li>)}</ul>}
        </div>
    )
}
