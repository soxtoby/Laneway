/** @jsxImportSource react */
import { Button as AriaButton } from "react-aria-components/Button"
import { Text, type ToastProps, UNSTABLE_Toast as Toast, UNSTABLE_ToastContent as ToastContent, UNSTABLE_ToastQueue as ToastQueue, UNSTABLE_ToastRegion as ToastRegion } from "react-aria-components/Toast"
import { Button } from "./Button"
import { X } from "./icons"
import "./Toast.css"
import { type CSSProperties } from "react"
import { flushSync } from "react-dom"

// Define the type for your toast content. This interface defines the properties of your toast content, affecting what you
// pass to the queue calls as arguments.
interface MyToastContent {
    title: string
    description?: string
    /** Laneway: an action such as Undo, which also closes the toast. */
    action?: { label: string; onAction: () => void }
}

// This is a global toast queue, to be imported and called where ever you want to queue a toast via queue.add().
export const queue = new ToastQueue<MyToastContent>({
    // Wrap state updates in a CSS view transition.
    wrapUpdate(fn) {
        if ("startViewTransition" in document) {
            // Laneway: a toast replaced at once interrupts its transition, which then rejects; the update still applies.
            document.startViewTransition(() => {
                flushSync(fn)
            }).ready.catch(() => {})
        } else {
            fn()
        }
    },
})

export function MyToastRegion() {
    return (
        // The ToastRegion should be rendered at the root of your app.
        <ToastRegion queue={queue}>
            {({ toast }) => (
                <MyToast toast={toast} style={{ viewTransitionName: toast.key } as CSSProperties}>
                    <ToastContent>
                        <Text slot="title">{toast.content.title}</Text>
                        {toast.content.description && <Text slot="description">{toast.content.description}</Text>}
                    </ToastContent>
                    {toast.content.action && (
                        <AriaButton
                            className="toast-action"
                            onPress={() => {
                                toast.content.action!.onAction()
                                queue.close(toast.key)
                            }}
                        >
                            {toast.content.action.label}
                        </AriaButton>
                    )}
                    <Button slot="close" aria-label="Close" variant="quiet">
                        <X size={16} />
                    </Button>
                </MyToast>
            )}
        </ToastRegion>
    )
}

export function MyToast(props: ToastProps<MyToastContent>) {
    return <Toast {...props} />
}
