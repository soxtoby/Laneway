import { useEffect } from "react"
import type { AppController } from "./app-controller"
import type { Notice } from "./notice"
import { MyToastRegion, queue } from "./ui/Toast"

let transientDuration = 5_000

/**
 * Shows the app's notice as the kit's toast. One shows at a time, as a new notice replaces the last;
 * the toast's timer waits while the pointer or focus is on it.
 */
export function Notices({ controller, notice }: { controller: AppController; notice?: Notice }) {
    useEffect(() => {
        if (!notice)
            return
        let replaced = false
        let key = queue.add({
            title: notice.message,
            description: notice.code,
            action: notice.action && { label: notice.action.label, onAction: notice.action.run },
        }, {
            timeout: notice.transient ? notice.duration ?? transientDuration : undefined,
            onClose: () => replaced || controller.dismissNotice(notice),
        })
        return () => {
            replaced = true
            queue.close(key)
        }
    }, [controller, notice])
    return <MyToastRegion />
}
