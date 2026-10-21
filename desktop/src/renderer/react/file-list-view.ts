import type { ChangedFile, FileListView } from "@laneway/shared"

/** The change a file list groups by: files that are new, altered in place, or gone. */
export type ChangeGroup = "added" | "changed" | "removed"
/** What a file list groups by kind: prose for readers, hand-written code, its tests, or tool output. */
export type FileKind = "docs" | "implementation" | "test" | "generated"

/** A row of a file list: a group or folder that folds, or a file. Keys are unique within the list. */
export type FileTreeNode =
    | { kind: "group" | "folder"; key: string; label: string; files: ChangedFile[]; children: FileTreeNode[] }
    | { kind: "file"; key: string; file: ChangedFile }

export let fileListViewOptions = {
    layout: [{ value: "flat", label: "Flat list" }, { value: "tree", label: "Folders" }],
    grouping: [{ value: "none", label: "No grouping" }, { value: "change", label: "Group by change" }, { value: "kind", label: "Group by file kind" }],
} as const satisfies { layout: { value: FileListView["layout"]; label: string }[]; grouping: { value: FileListView["grouping"]; label: string }[] }

/** The rows of a file list: grouped if the view groups, then folded into folders if it shows them. */
export function fileTreeNodes(files: ChangedFile[], view: FileListView): FileTreeNode[] {
    let section = (sectionFiles: ChangedFile[], prefix: string): FileTreeNode[] =>
        view.layout == "flat" ? fileNodes(sectionFiles) : folderNodes(buildTree(sectionFiles), prefix)
    if (view.grouping == "none")
        return section(files, "")
    return groupFiles(files, view.grouping).map(group => ({
        kind: "group",
        key: `${group.id}:`,
        label: group.label,
        files: group.files,
        children: section(group.files, `${group.id}:`),
    }))
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
// Prose formats. Plain text isn't one: requirements.txt and CMakeLists.txt are build input.
let docsExtensions = new Set(["md", "mdx", "markdown", "rst", "adoc", "asciidoc"])
// Names projects give their front-page documents, counted only without an extension or as plain text
// (README, LICENSE-MIT, CHANGES.txt), so code such as changes.ts or security.py stays implementation.
let docsNames =
    /^(readme|changelog|changes|history|news|contributing|contributors|authors|license|licence|copying|notice|patents|code_of_conduct|security|support|maintainers)(-.*)?$/i

/**
 * Generated wins wherever a file sits, then anything in a test directory is a test, so a test's
 * README or Markdown fixture stays with the tests. Otherwise the file's own name decides: documentation
 * comes before test name shapes, since no runner executes Markdown, and folders such as `docs/` don't
 * count, so documentation tooling stays implementation.
 */
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
    if (docsExtensions.has(extension) || ((extension == "" || extension == "txt") && docsNames.test(stem)))
        return "docs"
    if (testExtensions.has(extension) || testNames.some(pattern => pattern.test(stem)))
        return "test"
    return "implementation"
}

let changeGroups: { id: ChangeGroup; label: string }[] = [{ id: "added", label: "Added" }, { id: "changed", label: "Changed" }, {
    id: "removed",
    label: "Removed",
}]
// Reading order for a change: what it intends, the code, the tests that prove it, then output rarely worth reading.
let kindGroups: { id: FileKind; label: string }[] = [{ id: "docs", label: "Docs" }, { id: "implementation", label: "Implementation" }, {
    id: "test",
    label: "Tests",
}, { id: "generated", label: "Generated" }]

/** Splits `files` into the non-empty groups `grouping` asks for, in their fixed display order. */
export function groupFiles(files: ChangedFile[], grouping: Exclude<FileListView["grouping"], "none">) {
    let definitions: { id: ChangeGroup | FileKind; label: string }[] = grouping == "change" ? changeGroups : kindGroups
    let classify = grouping == "change" ? changeGroup : (file: ChangedFile) => fileKind(file.path)
    let groups = definitions.map(definition => ({ ...definition, files: [] as ChangedFile[] }))
    for (let file of files)
        groups.find(group => group.id == classify(file))!.files.push(file)
    return groups.filter(group => group.files.length > 0)
}

interface Directory {
    files: ChangedFile[]
    children: Map<string, Directory>
}

function buildTree(files: ChangedFile[]): Directory {
    let tree: Directory = { files: [], children: new Map() }
    for (let file of files) {
        let directory = tree
        for (let part of file.path.split("/").slice(0, -1)) {
            let child = directory.children.get(part)
            if (!child) {
                child = { files: [], children: new Map() }
                directory.children.set(part, child)
            }
            directory = child
        }
        directory.files.push(file)
    }
    return tree
}

function directoryFiles(directory: Directory): ChangedFile[] {
    return [...directory.files, ...[...directory.children.values()].flatMap(directoryFiles)]
}

// A run of folders holding nothing but the next folder collapses into one row.
function folderNodes(directory: Directory, prefix: string): FileTreeNode[] {
    let folders = [...directory.children].map(([name, child]): FileTreeNode => {
        let label = name
        while (child.files.length == 0 && child.children.size == 1) {
            let [[nextName, next]] = child.children
            label += `/${nextName}`
            child = next
        }
        let key = `${prefix}${label}/`
        return { kind: "folder", key, label, files: directoryFiles(child), children: folderNodes(child, key) }
    })
    return [...folders, ...fileNodes(directory.files)]
}

function fileNodes(files: ChangedFile[]): FileTreeNode[] {
    return files.map(file => ({ kind: "file", key: file.path, file }))
}
