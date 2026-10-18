/** @jsxImportSource react */
import { Archive, ArrowDownToLine, ArrowRight, Check, ChevronDown, ChevronsLeft, ChevronsRight, Copy, Ellipsis, ExternalLink, FaceSlightlySmiling, Folder, GitBranch, GitCompareArrows, type IconNode, Image, ImagePlus, ListTree, Maximize2, Minimize2, Minus, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Search, SlidersHorizontal, Sun, TriangleAlert, Type, Undo2, X } from "lucide"
import { createElement, type ReactNode } from "react"
import { customIconPaths } from "../src/icon-nodes"
import { lucideIcon } from "./ui/icons"

// Application icons, drawn from the same Lucide nodes as the Remix renderer's (ADR 0020).
export let ArchiveIcon = lucideIcon(Archive, "archive")
export let PullIcon = lucideIcon(ArrowDownToLine, "arrow-down-to-line")
export let MoreIcon = lucideIcon(Ellipsis, "ellipsis")
export let OpenColumnIcon = lucideIcon(ExternalLink, "external-link")
export let FolderIcon = lucideIcon(Folder, "folder")
export let BranchIcon = lucideIcon(GitBranch, "git-branch")
export let TreeIcon = lucideIcon(ListTree, "list-tree")
export let MaximizeIcon = lucideIcon(Maximize2, "maximize-2")
export let DeletedIcon = lucideIcon(Minus, "minus")
export let MoonIcon = lucideIcon(Moon, "moon")
export let CollapsePanelIcon = lucideIcon(PanelLeftClose, "panel-left-close")
export let ExpandPanelIcon = lucideIcon(PanelLeftOpen, "panel-left-open")
export let ModifiedIcon = lucideIcon(Pencil, "pencil")
export let AddIcon = lucideIcon(Plus, "plus")
export let RedoIcon = lucideIcon(Redo2, "redo-2")
export let SearchIcon = lucideIcon(Search, "search")
export let SettingsIcon = lucideIcon(SlidersHorizontal, "sliders-horizontal")
export let SunIcon = lucideIcon(Sun, "sun")
export let UndoIcon = lucideIcon(Undo2, "undo-2")
export let CloseIcon = lucideIcon(X, "x")
export let CollapseColumnIcon = lucideIcon(ChevronsLeft, "chevrons-left")
export let ExpandColumnIcon = lucideIcon(ChevronsRight, "chevrons-right")
export let RestoreIcon = lucideIcon(Minimize2, "minimize-2")
export let WarningIcon = lucideIcon(TriangleAlert, "triangle-alert")
export let CompareIcon = lucideIcon(GitCompareArrows, "git-compare-arrows")
export let CheckIcon = lucideIcon(Check, "check")
export let CopyIcon = lucideIcon(Copy, "copy")
export let ChevronDownIcon = lucideIcon(ChevronDown, "chevron-down")
export let IconTypeIcon = lucideIcon(Image, "image")
export let EmojiTypeIcon = lucideIcon(FaceSlightlySmiling, "face-slightly-smiling")
export let MonogramTypeIcon = lucideIcon(Type, "type")
export let ImageTypeIcon = lucideIcon(ImagePlus, "image-plus")

/** Any Lucide icon by its node data, such as one chosen from the catalog for a Repository Icon. */
export function LucideGlyph({ node }: { node: IconNode }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {node.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
        </svg>
    )
}

let statusIcons: Record<string, typeof AddIcon> = {
    added: AddIcon,
    deleted: lucideIcon(Minus, "minus"),
    modified: lucideIcon(Pencil, "pencil"),
    renamed: lucideIcon(ArrowRight, "arrow-right"),
    copied: lucideIcon(Copy, "copy"),
    conflicted: lucideIcon(TriangleAlert, "triangle-alert"),
}

/** How a file changed, as an icon named for its Git status. */
export function FileStatusIcon({ status }: { status: string }) {
    let Icon = statusIcons[status] ?? AddIcon
    return <Icon className="file-status" data-status={status} role="img" aria-label={status} aria-hidden={false} />
}

/** A head cut off from any branch: Laneway's own stroke, as Lucide has none (ADR 0020). */
export function DetachedIcon({ className }: { className?: string }) {
    return (
        <svg
            width={16}
            height={16}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={className}
        >
            <path d={customIconPaths.detached} />
        </svg>
    )
}

// The diff controls' own strokes, drawn on a 16-unit grid as the Remix renderer draws them.
function DiffStroke({ children, strokeWidth = 1.25 }: { children: ReactNode; strokeWidth?: number }) {
    return (
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true">
            {children}
        </svg>
    )
}

export function UnifiedDiffIcon() {
    return (
        <DiffStroke>
            <rect x="2" y="2" width="12" height="12" rx="1" />
            <path d="M4 5h8M4 8h8M4 11h8" />
        </DiffStroke>
    )
}

export function SplitDiffIcon() {
    return (
        <DiffStroke>
            <rect x="2" y="2" width="12" height="12" rx="1" />
            <path d="M8 2v12M4 5h2M10 5h2M4 8h2M10 8h2" />
        </DiffStroke>
    )
}

export function BreakoutDiffIcon() {
    return (
        <DiffStroke>
            <path d="M9 2h5v5M14 2 7 9M7 3H2v11h11V9" />
        </DiffStroke>
    )
}

export function WhitespaceIcon() {
    return (
        <DiffStroke strokeWidth={1.5}>
            <path d="M13 2H6a3.5 3.5 0 0 0 0 7h2M8 2v12M11 2v12" />
        </DiffStroke>
    )
}

export function EntireFileIcon() {
    return (
        <DiffStroke>
            <path d="M9 1.5H3v13h10v-9L9 1.5ZM9 1.5v4h4M5 8h6M5 11h6" />
        </DiffStroke>
    )
}

// Solid and outlined shapes stay distinct at toolbar size, where thin frames blur together.
export function ImageModeIcon({ mode }: { mode: "side-by-side" | "swipe" | "onion" | "difference" }) {
    return (
        <DiffStroke strokeWidth={1.5}>
            {mode == "side-by-side"
                ? (
                    // A solid picture beside an outlined one.
                    <>
                        <path d="M1.5 3h5.5v10H1.5z" fill="currentColor" stroke="none" />
                        <path d="M9 3h5.5v10H9z" />
                    </>
                )
                : mode == "swipe"
                ? (
                    // A picture half revealed by a divider that stretches past its frame.
                    <>
                        <path d="M2 3h6v10H2z" fill="currentColor" stroke="none" />
                        <path d="M2 3h12v10H2zM8 1v14" />
                    </>
                )
                : mode == "onion"
                ? (
                    // An outlined picture laid over a solid one.
                    <>
                        <path d="M2 2h8v8H2z" fill="currentColor" stroke="none" />
                        <path d="M6 6h8v8H6z" />
                    </>
                )
                : (
                    // Two discs with their overlap picked out.
                    <>
                        <path d="M8 4.54A4 4 0 0 1 8 11.46A4 4 0 0 1 8 4.54z" fill="currentColor" stroke="none" />
                        <path d="M2 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M6 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0" />
                    </>
                )}
        </DiffStroke>
    )
}
