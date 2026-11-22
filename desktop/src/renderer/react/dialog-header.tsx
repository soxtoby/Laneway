import type { ReactNode } from "react"
import { IconButton } from "./controls"
import { CloseIcon } from "./icons"

/**
 * A dialog's title bar: a band across its top holding its title, optionally after a `dialog-title-icon` and before a
 * `dialog-title-detail`, with a Close button at its end. The button closes the dialog as Escape does, through its
 * modal's `onOpenChange`, so a controller that keeps the dialog while Git runs keeps it here too; `isDismissDisabled`
 * disables it while the dialog's Cancel is.
 */
export function DialogHeader({ children, isDismissDisabled }: { children: ReactNode; isDismissDisabled?: boolean }) {
    return (
        <header className="dialog-header">
            {children}
            <IconButton slot="close" label="Close" className="dialog-close" isDisabled={isDismissDisabled}>
                <CloseIcon />
            </IconButton>
        </header>
    )
}
