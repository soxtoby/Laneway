import { Archive, ArrowDownToLine, ArrowLeftRight, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsLeft, ChevronsRight, ChevronsUpDown, Copy, Diff, Ellipsis, ExternalLink, FaceSlightlySmiling, FileText, Folder, GitBranch, GitCompareArrows, GitFork, GitGraph, GripVertical, House, type IconNode, Image, ImagePlus, ListTree, Maximize2, Minimize2, Minus, Moon, PackagePlus, Pencil, Plus, Redo2, RefreshCw, Search, Settings, SlidersHorizontal, Sun, Tag, TriangleAlert, Type, Undo2, X } from "lucide"

export type { IconNode }

/**
 * The application's icons, mostly Lucide nodes drawn on a 24-unit grid. A few concepts Lucide does
 * not draw stay as 16-unit strokes, so every name renders through the same `Icon` component.
 */
export let iconNodes = {
    search: Search,
    pull: ArrowDownToLine,
    stash: Archive,
    "stash-add": PackagePlus,
    undo: Undo2,
    redo: Redo2,
    sun: Sun,
    moon: Moon,
    sliders: SlidersHorizontal,
    refresh: RefreshCw,
    warning: TriangleAlert,
    plus: Plus,
    minus: Minus,
    close: X,
    "chevron-right": ChevronRight,
    "chevron-down": ChevronDown,
    "expand-all": ChevronsUpDown,
    "collapse-all": ChevronsDownUp,
    "collapse-left": ChevronsLeft,
    "collapse-right": ChevronsRight,
    maximize: Maximize2,
    restore: Minimize2,
    home: House,
    folder: Folder,
    switch: ArrowLeftRight,
    grip: GripVertical,
    more: Ellipsis,
    graph: GitGraph,
    branch: GitBranch,
    external: ExternalLink,
    tag: Tag,
    fork: GitFork,
    document: FileText,
    diff: Diff,
    compare: GitCompareArrows,
    pencil: Pencil,
    copy: Copy,
    "list-tree": ListTree,
    check: Check,
    image: Image,
    "image-plus": ImagePlus,
    emoji: FaceSlightlySmiling,
    type: Type,
    settings: Settings,
} satisfies Record<string, IconNode>

/** Hand-drawn 16-unit strokes for concepts Lucide has no icon for. */
export let customIconPaths = {
    // A head with no branch line above it: the node and its history, cut off from any ref.
    detached: "M5.5 9a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8 11.5V15M8 1.5v1M8 4.5v1.5",
} as const

export type IconName = keyof typeof iconNodes | keyof typeof customIconPaths

export function isCustomIcon(name: IconName): name is keyof typeof customIconPaths {
    return name in customIconPaths
}
