/** @jsxImportSource react */
import type { MissingOpenRepository } from "@laneway/shared"
import { repositoryName } from "./repositories"
import { Button } from "./ui/Button"

/** The active repository can't be found where it was; it can be located again or closed. */
export function MissingRepository({ repository, onLocate, onClose }: { repository: MissingOpenRepository; onLocate(): void; onClose(): void }) {
    return (
        <section className="missing-repository" aria-labelledby="missing-repository-heading">
            <p className="missing-detail">Repository unavailable</p>
            <h1 id="missing-repository-heading" className="missing-title">{repositoryName(repository)}</h1>
            <p className="missing-detail">{repository.path}</p>
            <p className="missing-detail">{repository.error.message}</p>
            <div className="missing-actions">
                <Button variant="accent" onPress={onLocate}>Locate</Button>
                <Button variant="secondary" onPress={onClose}>Close</Button>
            </div>
        </section>
    )
}
