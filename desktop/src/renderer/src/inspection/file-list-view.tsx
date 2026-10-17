import type { ChangedFile, FileListView } from "@laneway/shared"
import { css, type Handle } from "remix/ui"
import { type OverflowAction, OverflowMenu } from "../overflow-menu"

/** The change a file list groups by: files that are new, altered in place, or gone. */
export type ChangeGroup = "added" | "changed" | "removed"

/** What a file list groups by kind: hand-written code, its tests, or tool output. */
export type FileKind = "implementation" | "test" | "generated"

export interface FileGroup {
    id: ChangeGroup | FileKind
    label: string
    files: ChangedFile[]
}

export function changeGroup(file: ChangedFile): ChangeGroup {
    if (file.status == "deleted")
        return "removed"
    if (file.status == "added" || file.untracked)
        return "added"
    return "changed"
}

// Directories whose contents are tests, however the files inside are named.
let testDirectories = new Set([
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
    "__mocks__",
    "__snapshots__",
    "__fixtures__",
    "fixtures",
    "testdata",
    "testing",
    "e2e",
    "cypress",
])

// Name shapes test runners look for: foo.test.ts, foo.spec.js, foo_test.go, test_foo.py, FooTest.java, FooSpec.scala, conftest.py.
let testNames = [/(^|[._-])(test|tests|spec|specs|e2e)([._-]|$)/i, /(Test|Tests|Spec|Specs)$/, /^conftest$/]
let testExtensions = new Set(["snap", "feature", "t"])

// Directories holding build output or third-party copies rather than this repository's own source.
let generatedDirectories = new Set([
    "node_modules",
    "bower_components",
    "vendor",
    "dist",
    "build",
    "out",
    "generated",
    "__generated__",
    ".generated",
    "pods",
    "obj",
])

// Lock files and other whole-file tool output, matched against the lower-cased file name.
let generatedFiles = new Set([
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "deno.lock",
    "cargo.lock",
    "composer.lock",
    "gemfile.lock",
    "podfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "pdm.lock",
    "go.sum",
    "flake.lock",
    "mix.lock",
    "pubspec.lock",
    "packages.lock.json",
    "project.assets.json",
    "paket.lock",
    "gradle.lockfile",
    "package.resolved",
    ".terraform.lock.hcl",
])

// Name shapes code generators and bundlers produce, matched against the lower-cased file name.
let generatedNames = [
    /\.min\.(js|mjs|cjs|css)$/,
    /\.(bundle|chunk)\.(js|mjs|cjs)$/,
    /\.(js|mjs|cjs|css)\.map$/,
    /\.pb\.[a-z]+$/,
    /_pb2(_grpc)?\.py$/,
    /\.(pbjson|pbenum|pbserver|pbobjc)\.[a-z]+$/,
    /\.g\.(cs|dart|vb)$/,
    /\.freezed\.dart$/,
    /\.designer\.(cs|vb)$/,
    /\.generated\.[a-z]+$/,
    /\.gen\.[a-z]+$/,
    /_generated\.[a-z]+$/,
    /_gen\.[a-z]+$/,
    /^zz_generated/,
    /\.lock(b|file)?$/,
    /\.tfstate(\.backup)?$/,
    /\.(pbxproj|nib|xcworkspacedata|xcuserstate)$/,
    /\.(pyc|mo)$/,
]

export function fileKind(path: string): FileKind {
    let segments = path.split("/")
    let name = segments.pop()!
    let lower = name.toLowerCase()
    if (segments.some(segment => generatedDirectories.has(segment.toLowerCase())))
        return "generated"
    if (generatedFiles.has(lower) || generatedNames.some(pattern => pattern.test(lower)))
        return "generated"
    if (segments.some(segment => testDirectories.has(segment.toLowerCase())))
        return "test"
    let dot = name.lastIndexOf(".")
    let stem = dot > 0 ? name.slice(0, dot) : name
    let extension = dot > 0 ? lower.slice(dot + 1) : ""
    if (testExtensions.has(extension) || testNames.some(pattern => pattern.test(stem)))
        return "test"
    return "implementation"
}

let changeGroups: { id: ChangeGroup; label: string }[] = [{ id: "added", label: "Added" }, { id: "changed", label: "Changed" }, {
    id: "removed",
    label: "Removed",
}]
let kindGroups: { id: FileKind; label: string }[] = [{ id: "implementation", label: "Implementation" }, { id: "test", label: "Tests" }, {
    id: "generated",
    label: "Generated",
}]

/** Splits `files` into the non-empty groups `grouping` asks for, in their fixed display order. */
export function groupFiles(files: ChangedFile[], grouping: Exclude<FileListView["grouping"], "none">): FileGroup[] {
    let definitions: { id: ChangeGroup | FileKind; label: string }[] = grouping == "change" ? changeGroups : kindGroups
    let classify = grouping == "change" ? changeGroup : (file: ChangedFile) => fileKind(file.path)
    let groups = definitions.map(definition => ({ ...definition, files: [] as ChangedFile[] }))
    for (let file of files)
        groups.find(group => group.id == classify(file))!.files.push(file)
    return groups.filter(group => group.files.length > 0)
}

export let fileListViewOptions = {
    layout: [{ value: "flat", label: "Flat list" }, { value: "tree", label: "Folders" }],
    grouping: [{ value: "none", label: "No grouping" }, { value: "change", label: "Group by change" }, { value: "kind", label: "Group by file kind" }],
} as const satisfies { layout: { value: FileListView["layout"]; label: string }[]; grouping: { value: FileListView["grouping"]; label: string }[] }

/** A button opening the layout and grouping choices for the file lists; the choice applies to every list. */
export function FileListViewMenu(
    handle: Handle<{ label: string; view: FileListView; change(view: FileListView): void; trigger?: ReturnType<typeof css>; size?: number }>,
) {
    return () => {
        let { view, change } = handle.props
        let actions: OverflowAction[] = [
            ...fileListViewOptions.layout.map(option => ({
                label: option.label,
                checked: view.layout == option.value,
                run: () => change({ ...view, layout: option.value }),
            })),
            ...fileListViewOptions.grouping.map((option, index) => ({
                label: option.label,
                separator: index == 0,
                checked: view.grouping == option.value,
                run: () => change({ ...view, grouping: option.value }),
            })),
        ]
        return (
            <OverflowMenu
                label={handle.props.label}
                title="File list view"
                icon="list-tree"
                trigger={handle.props.trigger}
                size={handle.props.size}
                actions={actions}
            />
        )
    }
}
