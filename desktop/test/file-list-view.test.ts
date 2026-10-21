import type { ChangedFile } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { changeGroup, fileKind, groupFiles } from "../src/renderer/react/file-list-view"

function file(path: string, status = "modified", untracked = false): ChangedFile {
    return { path, status, staged: false, unstaged: true, untracked, ignored: false, conflicted: false }
}

describe("file list view", () => {
    test("groups changes as added, changed, or removed", () => {
        expect(changeGroup(file("a.ts", "added"))).toBe("added")
        expect(changeGroup(file("a.ts", "added", true))).toBe("added")
        expect(changeGroup(file("a.ts", "deleted"))).toBe("removed")
        for (let status of ["modified", "renamed", "copied", "type changed", "conflicted"])
            expect(changeGroup(file("a.ts", status))).toBe("changed")
    })

    test("recognizes tests by directory and by file name", () => {
        for (
            let path of [
                "test/renderer.test.ts",
                "src/__tests__/app.ts",
                "spec/models/user_spec.rb",
                "src/app.spec.ts",
                "pkg/server_test.go",
                "tests/test_api.py",
                "src/test/java/FooTest.java",
                "src/FooTests.cs",
                "src/FooSpec.scala",
                "conftest.py",
                "e2e/login.cy.ts",
                "features/login.feature",
                "cypress/support/commands.js",
                "src/__snapshots__/app.snap",
            ]
        ) {
            expect(fileKind(path), path).toBe("test")
        }
    })

    test("recognizes generated files by directory, lock file, and suffix", () => {
        for (
            let path of [
                "bun.lock",
                "package-lock.json",
                "Cargo.lock",
                "go.sum",
                "dist/app.js",
                "vendor/lib/thing.go",
                "src/__generated__/schema.ts",
                "assets/app.min.js",
                "assets/app.js.map",
                "api/service.pb.go",
                "api/service_pb2.py",
                "Models/Thing.g.cs",
                "Forms/Main.Designer.cs",
                "lib/model.freezed.dart",
                "pkg/zz_generated.deepcopy.go",
                "src/types.generated.ts",
                "src/api.gen.ts",
                "App.xcodeproj/project.pbxproj",
                "infra/terraform.tfstate",
            ]
        ) {
            expect(fileKind(path), path).toBe("generated")
        }
    })

    test("recognizes docs by extension and by well-known name", () => {
        for (
            let path of [
                "README.md",
                "docs/guide/install.mdx",
                "notes.markdown",
                "docs/index.rst",
                "manual.adoc",
                "LICENSE",
                "LICENSE-MIT",
                "packages/cli/CHANGES.txt",
                "docs/test-plan.md",
            ]
        ) {
            expect(fileKind(path), path).toBe("docs")
        }
    })

    test("keeps docs in test and generated directories with those directories", () => {
        expect(fileKind("test/README.md")).toBe("test")
        expect(fileKind("node_modules/left-pad/README.md")).toBe("generated")
    })

    test("treats everything else as implementation", () => {
        for (
            let path of [
                "src/app.tsx",
                "src/latest.ts",
                "src/contest.ts",
                "src/Manifest.ts",
                "src/testing-library.ts",
                "src/integration/slack.ts",
                "shared/src/changes.ts",
                "requirements.txt",
                "CMakeLists.txt",
                "docs/conf.py",
                "docs/.vitepress/config.ts",
                "bin/lane",
                "playwright.config.ts",
                "src/builder/index.ts",
                "lockfile-reader.ts",
            ]
        ) {
            expect(fileKind(path), path).toBe("implementation")
        }
    })

    test("orders groups fixedly and drops empty ones", () => {
        let files = [file("a.ts", "deleted"), file("b.ts", "added"), file("c.ts"), file("d.ts", "added")]
        let byChange = groupFiles(files, "change").map(group => `${group.label}: ${group.files.map(file => file.path).join(" ")}`)
        expect(byChange).toEqual(["Added: b.ts d.ts", "Changed: c.ts", "Removed: a.ts"])
        let kinds = [file("test/a.test.ts"), file("src/a.ts"), file("bun.lock"), file("README.md")]
        expect(groupFiles(kinds, "kind").map(group => group.label)).toEqual(["Docs", "Implementation", "Tests", "Generated"])
        expect(groupFiles([file("src/a.ts")], "kind").map(group => group.label)).toEqual(["Implementation"])
    })
})
