/** @jsxImportSource react */
import { Archive, ArrowDownToLine, ChevronsLeft, ChevronsRight, Ellipsis, ExternalLink, FaceSlightlySmiling, Folder, GitBranch, GitCompareArrows, type IconNode, Image, ImagePlus, ListTree, Maximize2, Minimize2, Minus, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Search, SlidersHorizontal, Sun, TriangleAlert, Type, Undo2, X } from "lucide"
import { createElement } from "react"
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
