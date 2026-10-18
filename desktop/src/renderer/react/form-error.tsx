/** @jsxImportSource react */
import { useEffect, useRef } from "react"

/** A form's failure, focused when it appears so it is read out. */
export function FormError({ message }: { message?: string }) {
    let alert = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (message)
            alert.current?.focus()
    }, [message])
    if (!message)
        return null
    return <div ref={alert} className="form-error" role="alert" tabIndex={-1}>{message}</div>
}
