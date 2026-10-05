import { css, type Handle, on, ref } from "remix/ui"
import * as listbox from "remix/ui/listbox"
import type { LensResult } from "./branch-workspace"

let lensBackdrop = css({
    position: "fixed",
    zIndex: "50",
    inset: "0",
    padding: "14vh 18px 18px",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    background: "transparent",
    width: "100vw",
    height: "100vh",
    maxHeight: "none",
    maxWidth: "none",
    margin: "0",
    border: "0",
    borderRadius: "0",
    boxShadow: "none",
})

let commandLens = css({
    width: "min(600px, 100%)",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "8px",
    background: "var(--raised)",
    boxShadow: "var(--shadow-dialog)",
    "@media (forced-colors: active)": {
        boxShadow: "none",
    },
})

let commandLensHeader = css({
    height: "40px",
    padding: "0 12px",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    gap: "10px",
    borderBottom: "1px solid var(--line)",
})

let commandLensSearchInput = css({
    height: "100%",
    padding: "0",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    fontFamily: "inherit",
    fontSize: "14px",
    "&:hover": {
        border: "0",
        boxShadow: "none",
    },
    "&:focus": {
        border: "0",
        boxShadow: "none",
    },
})

let lensGuidance = css({
    margin: "0",
    padding: "16px 14px",
    color: "var(--muted)",
    fontSize: "12px",
})

let lensResults = css({
    maxHeight: "46vh",
    padding: "4px",
    overflowY: "auto",
})

let lensResultsButton = css({
    width: "100%",
    minHeight: "38px",
    padding: "5px 8px",
    display: "grid",
    gridTemplateColumns: "38px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "9px",
    color: "var(--text)",
    textAlign: "left",
    border: "1px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    '&[data-highlighted="true"]': {
        borderColor: "var(--accent-edge)",
        background: "var(--accent-wash-strong)",
    },
})

let lensKind = css({
    color: "var(--accent)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    "&.branch": {
        color: "var(--warning)",
    },
    "&:nth-child(2)": {
        minWidth: "0",
        display: "grid",
        gap: "1px",
    },
})

let lensResultsSpan = css({
    "&:nth-child(2)": {
        minWidth: "0",
        display: "grid",
        gap: "1px",
    },
})

let lensResultsStrong = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "13px",
})

let lensResultsSmall = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--faint)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
})

export function CommandLens(
    handle: Handle<{
        query: string
        prompt?: string
        results: LensResult[]
        inputRef(node: HTMLInputElement): void
        setQuery(value: string): void
        close(): void
        activate(result: LensResult): Promise<void>
    }>,
) {
    let active: string | null = null
    let list: listbox.ListboxRef | undefined
    let search: HTMLInputElement
    let listId = `${handle.id}-results`

    return () => {
        let { results, query } = handle.props
        let highlighted = results.some(result => resultId(result) == active) ? active : results[0] ? resultId(results[0]) : null
        handle.queueTask(() => {
            let id = list?.active?.id
            if (id)
                search.setAttribute("aria-activedescendant", id)
            else
                search.removeAttribute("aria-activedescendant")
        })

        return (
            <dialog
                class="lens-backdrop"
                aria-label="Command Lens"
                mix={[
                    lensBackdrop,
                    ref(dialog => dialog.showModal()),
                    on("cancel", event => {
                        event.preventDefault()
                        handle.props.close()
                    }),
                    on("click", event => {
                        if (event.target == event.currentTarget)
                            handle.props.close()
                    }),
                ]}
            >
                <listbox.Context
                    value={null}
                    activeValue={highlighted}
                    ref={value => list = value}
                    onHighlight={value => {
                        active = value
                        void handle.update()
                    }}
                    onSelect={value => {
                        let result = handle.props.results.find(result => resultId(result) == value)
                        if (result)
                            void handle.props.activate(result)
                    }}
                >
                    <section class="command-lens" mix={commandLens}>
                        <header mix={commandLensHeader}>
                            <span aria-hidden="true">⌕</span>
                            <input
                                aria-label="Command Lens search"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-expanded={results.length > 0}
                                aria-controls={listId}
                                placeholder={handle.props.prompt ?? "Search open repositories and branches."}
                                value={query}
                                mix={[
                                    commandLensSearchInput,
                                    ref(node => {
                                        search = node
                                        handle.props.inputRef(node)
                                        node.focus()
                                    }),
                                    on("input", event => {
                                        active = null
                                        handle.props.setQuery(event.currentTarget.value)
                                    }),
                                    on("keydown", event => {
                                        if (event.key == "ArrowDown" || event.key == "ArrowUp") {
                                            event.preventDefault()
                                            if (event.key == "ArrowDown")
                                                list?.navigateNext()
                                            else
                                                list?.navigatePrevious()
                                        } else if (event.key == "Enter") {
                                            event.preventDefault()
                                            void list?.selectActive()
                                        } else if (event.key == "Escape") {
                                            event.preventDefault()
                                            handle.props.close()
                                        }
                                    }),
                                ]}
                            />
                        </header>
                        {query.trim() == "" && (
                            <p class="lens-guidance" mix={lensGuidance}>
                                {handle.props.prompt ?? "Search open repositories and branches."}
                            </p>
                        )}
                        {query.trim() != "" && results.length == 0 && (
                            <p class="lens-guidance" role="status" mix={lensGuidance}>
                                No matches.
                            </p>
                        )}
                        <div
                            id={listId}
                            class="lens-results"
                            aria-label="Matching repositories, branches, and commands"
                            hidden={results.length == 0}
                            mix={[lensResults, listbox.list()]}
                        >
                            {results.map(result => (
                                <button
                                    key={resultId(result)}
                                    type="button"
                                    tabIndex={-1}
                                    mix={[
                                        lensResultsButton,
                                        listbox.option({ value: resultId(result), label: result.label }),
                                        on("mousedown", event => event.preventDefault()),
                                    ]}
                                >
                                    <span class={`lens-kind ${result.kind}`} mix={lensKind}>
                                        {result.kind == "repository" ? "REPO" : result.kind == "command" ? "CMD" : "BR"}
                                    </span>
                                    <span mix={lensResultsSpan}>
                                        <strong mix={lensResultsStrong}>
                                            {result.label}
                                        </strong>
                                        <small mix={lensResultsSmall}>
                                            {result.detail}
                                        </small>
                                    </span>
                                    <kbd>↵</kbd>
                                </button>
                            ))}
                        </div>
                    </section>
                </listbox.Context>
            </dialog>
        )
    }
}

function resultId(result: LensResult) {
    return JSON.stringify([result.kind, result.repositoryId, result.nodeId, result.kind == "command" ? result.delta : null])
}
