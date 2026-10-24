import { createReactComponent, IconAdjustmentsHorizontal, IconAlertTriangle, IconArchive, IconArrowBackUp, IconArrowBarToDown, IconArrowBarToUp, IconArrowBarToUpDashed, IconArrowForwardUp, IconArrowRight, IconArrowsDiagonal, IconArrowsDiagonalMinimize2, IconCheck, IconChevronDown, IconChevronsLeft, IconChevronsRight, IconCopy, IconDots, IconExternalLink, IconFileDiff, IconFolder, IconGitBranch, IconGitCompare, IconGitMerge, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLetterT, IconListTree, IconMinus, IconMoodSmile, IconMoon, IconPencil, IconPhoto, IconPhotoPlus, IconPlus, IconSearch, IconSelector, IconSun, IconTag, IconTextWrap, IconX } from "@tabler/icons-react"
import { createElement, type ReactNode } from "react"
import type { CatalogNode } from "./icon-catalog"
import { collapseAllNode, customIconPaths, forcePublishNode } from "./icon-nodes"
import { tablerIcon } from "./ui/icons"

// Application icons, from Tabler (ADR 0024).
export let ArchiveIcon = tablerIcon(IconArchive)
export let PullIcon = tablerIcon(IconArrowBarToDown)
export let PublishIcon = tablerIcon(IconArrowBarToUp)
export let PublishNewIcon = tablerIcon(IconArrowBarToUpDashed)
export let ForcePublishIcon = tablerIcon(createReactComponent("outline", "arrow-bar-to-up-double", "ArrowBarToUpDouble", forcePublishNode))
export let MoreIcon = tablerIcon(IconDots)
export let OpenColumnIcon = tablerIcon(IconExternalLink)
export let FolderIcon = tablerIcon(IconFolder)
export let BranchIcon = tablerIcon(IconGitBranch)
export let TreeIcon = tablerIcon(IconListTree)
export let MaximizeIcon = tablerIcon(IconArrowsDiagonal)
export let DeletedIcon = tablerIcon(IconMinus)
export let MoonIcon = tablerIcon(IconMoon)
export let CollapsePanelIcon = tablerIcon(IconLayoutSidebarLeftCollapse)
export let ExpandPanelIcon = tablerIcon(IconLayoutSidebarLeftExpand)
export let ModifiedIcon = tablerIcon(IconPencil)
export let AddIcon = tablerIcon(IconPlus)
export let RedoIcon = tablerIcon(IconArrowForwardUp)
export let SearchIcon = tablerIcon(IconSearch)
export let SettingsIcon = tablerIcon(IconAdjustmentsHorizontal)
export let SunIcon = tablerIcon(IconSun)
export let UndoIcon = tablerIcon(IconArrowBackUp)
export let CloseIcon = tablerIcon(IconX)
export let CollapseColumnIcon = tablerIcon(IconChevronsLeft)
export let ExpandColumnIcon = tablerIcon(IconChevronsRight)
export let RestoreIcon = tablerIcon(IconArrowsDiagonalMinimize2)
export let WarningIcon = tablerIcon(IconAlertTriangle)
export let CompareIcon = tablerIcon(IconGitCompare)
export let CheckIcon = tablerIcon(IconCheck)
export let CopyIcon = tablerIcon(IconCopy)
export let ChevronDownIcon = tablerIcon(IconChevronDown)
export let IconTypeIcon = tablerIcon(IconPhoto)
export let EmojiTypeIcon = tablerIcon(IconMoodSmile)
export let MonogramTypeIcon = tablerIcon(IconLetterT)
export let ImageTypeIcon = tablerIcon(IconPhotoPlus)
export let DiffIcon = tablerIcon(IconFileDiff)
export let ExpandAllIcon = tablerIcon(IconSelector)
export let CollapseAllIcon = tablerIcon(createReactComponent("outline", "chevrons-down-up", "ChevronsDownUp", collapseAllNode))
export let GraphIcon = tablerIcon(IconGitMerge)
export let TagIcon = tablerIcon(IconTag)
export let WrapLinesIcon = tablerIcon(IconTextWrap)

/** Laneway's Hidden L mark, from assets/brand/laneway-icon.svg, fitted to its 48-unit canvas. */
export function BrandMark() {
    return (
        <svg className="brand-mark" viewBox="8 8 48 48" aria-hidden>
            <path d="M20 8H24V48H44A4 4 0 0 0 44 40H34A2 2 0 0 1 32 38V12A4 4 0 0 1 36 8H44A12 12 0 0 1 56 20V44A12 12 0 0 1 44 56H20A12 12 0 0 1 8 44V20A12 12 0 0 1 20 8Z" />
        </svg>
    )
}

/** Any Tabler icon by its node data, such as one chosen from the catalog for a Repository Icon. */
export function CatalogGlyph({ node }: { node: CatalogNode }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {node.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
        </svg>
    )
}

let statusIcons: Record<string, typeof AddIcon> = {
    added: AddIcon,
    deleted: DeletedIcon,
    modified: ModifiedIcon,
    renamed: tablerIcon(IconArrowRight),
    copied: CopyIcon,
    conflicted: WarningIcon,
}

/** How a file changed, as an icon named for its Git status. */
export function FileStatusIcon({ status }: { status: string }) {
    let Icon = statusIcons[status] ?? AddIcon
    return <Icon className="file-status" data-status={status} role="img" aria-label={status} aria-hidden={false} />
}

/** A head cut off from any branch: Laneway's own stroke, as Tabler has none (ADR 0024). */
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

// The diff controls' own strokes, drawn on a 16-unit grid.
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

// Conflict resolution's whole-file choices and merge tool.
function ResolutionStroke({ d }: { d: string }) {
    return (
        <svg
            width={14}
            height={14}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={d} />
        </svg>
    )
}

export function TakeLeftIcon() {
    return <ResolutionStroke d="M11 2h3v12h-3M2 8h7M6 5l3 3-3 3" />
}

export function TakeRightIcon() {
    return <ResolutionStroke d="M5 2H2v12h3m9-6H7m3-3L7 8l3 3" />
}

export function MergeToolIcon() {
    return <ResolutionStroke d="M2 3h4v10H2ZM10 3h4v10h-4M6 8h4m-2-2 2 2-2 2" />
}
