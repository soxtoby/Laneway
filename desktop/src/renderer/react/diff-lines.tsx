import { useEffect, useEffectEvent, useRef, useState } from "react"
import { createDiffRenderer, type DiffLinesProps } from "./diff-renderer"

/** A file's changed lines, drawn by Pierre; the renderer owns everything inside the host's shadow root. */
export function DiffLines(props: DiffLinesProps) {
    let hostRef = useRef<HTMLDivElement>(null)
    let scrollbarRef = useRef<HTMLDivElement>(null)
    let rendererRef = useRef<ReturnType<typeof createDiffRenderer>>(undefined)
    let [contextError, setContextError] = useState<string>()
    let initial = useEffectEvent(() => props)
    useEffect(() => {
        let renderer = createDiffRenderer(hostRef.current!, scrollbarRef.current!, initial(), setContextError)
        rendererRef.current = renderer
        return () => {
            renderer.dispose()
            rendererRef.current = undefined
        }
    }, [])
    useEffect(() => rendererRef.current?.update(props))
    return (
        <>
            {props.page.lines.filter(line => line.kind == "notice" && !line.text.startsWith("\\ No newline")).map(line => (
                <div key={line.id} className="diff-notice">{line.text}</div>
            ))}
            {contextError && <p className="diff-notice" role="alert">{contextError}</p>}
            <div ref={hostRef} className={`pierre-diff diff-lines ${props.layout}`} aria-label="Changed lines" tabIndex={0} />
            {/* Sticks to the bottom of the scrolling column while any of the diff is in view. */}
            <div ref={scrollbarRef} className="diff-scrollbar" aria-hidden="true">
                <div className="diff-scrollbar-track" />
            </div>
        </>
    )
}
