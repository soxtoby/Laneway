/** @jsxImportSource react */
import { Archive, ArrowDownToLine, Ellipsis, ExternalLink, Folder, GitBranch, ListTree, Maximize2, Minus, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Search, SlidersHorizontal, Sun, Undo2, X } from "lucide"
import { lucideIcon } from "./ui/icons"

// The spike's icons, drawn from the same Lucide nodes as the Remix renderer's (ADR 0020).
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
