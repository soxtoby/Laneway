import { firstEmoji, monogramText, RepositoryIconSchema, repositoryInitials } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { customIconPaths, iconNodes } from "../src/renderer/react/icon-nodes"
import { iconLabel, lucideCatalog, popularIcons, searchLucide } from "../src/renderer/react/lucide-catalog"

describe("Application icons", () => {
    test("every name draws from Lucide node data or a hand-drawn stroke", () => {
        for (let [name, node] of Object.entries(iconNodes)) {
            expect(node.length, name).toBeGreaterThan(0)
            for (let [tag, attributes] of node) {
                expect(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"], `${name} uses <${tag}>`).toContain(tag)
                expect(Object.keys(attributes).length, name).toBeGreaterThan(0)
            }
        }
        expect(customIconPaths.detached).toMatch(/^M/)
    })

    test("the icon catalogue loads once and searches names and tags", async () => {
        // Another test in the same process may already have loaded the catalogue.
        let loaded = Promise.withResolvers<void>()
        let catalog = lucideCatalog(() => loaded.resolve())
        if (!catalog) {
            await loaded.promise
            catalog = lucideCatalog()!
        }
        expect(lucideCatalog()).toBe(catalog)
        expect(Object.keys(catalog.nodes).length).toBeGreaterThan(1500)
        // Every popular icon exists, so the empty query never shows gaps.
        expect(popularIcons.filter(name => !(name in catalog.nodes))).toEqual([])
        expect(searchLucide(catalog, "")).toEqual(popularIcons)
        expect(searchLucide(catalog, "git bra")[0]).toBe("git-branch")
        // "feline" is a tag on the cat icon rather than part of its name.
        expect(searchLucide(catalog, "feline")).toContain("cat")
        expect(searchLucide(catalog, "no such icon anywhere")).toEqual([])
        expect(iconLabel("folder-git-2")).toBe("Folder git 2")
    })
})

describe("Repository Icon overrides", () => {
    test("monograms normalize to one or two letters or numbers", () => {
        expect(monogramText(" t3 ")).toBe("T3")
        expect(monogramText("é")).toBe("É")
        expect(monogramText("文書")).toBe("文書")
        expect(monogramText("ABC")).toBeUndefined()
        expect(monogramText("-")).toBeUndefined()
        expect(monogramText("")).toBeUndefined()
    })

    test("pasted text yields its first emoji, including flags and keycaps", () => {
        expect(firstEmoji("🚀 launch")).toBe("🚀")
        expect(firstEmoji("🇳🇿")).toBe("🇳🇿")
        expect(firstEmoji("1️⃣")).toBe("1️⃣")
        expect(firstEmoji("plain text")).toBeUndefined()
        expect(firstEmoji("")).toBeUndefined()
    })

    test("initials take the first two words, then the first two characters", () => {
        expect(repositoryInitials("laneway-desktop")).toBe("LD")
        expect(repositoryInitials("Laneway")).toBe("LA")
        expect(repositoryInitials("")).toBe("GW")
    })

    test("icon overrides are validated by kind", () => {
        expect(RepositoryIconSchema.safeParse({ kind: "icon", name: "folder-code", color: "blue" }).success).toBe(true)
        expect(RepositoryIconSchema.safeParse({ kind: "icon", name: "Folder Code", color: "blue" }).success).toBe(false)
        expect(RepositoryIconSchema.safeParse({ kind: "icon", name: "folder-code", color: "beige" }).success).toBe(false)
        expect(RepositoryIconSchema.safeParse({ kind: "emoji", emoji: "🚀" }).success).toBe(true)
        expect(RepositoryIconSchema.safeParse({ kind: "monogram", text: "T3", color: "violet" }).success).toBe(true)
        expect(RepositoryIconSchema.safeParse({ kind: "image", path: "D:\\icons\\logo.svg" }).success).toBe(true)
        expect(RepositoryIconSchema.safeParse({ kind: "image", path: "D:\\icons\\logo.exe" }).success).toBe(false)
        expect(RepositoryIconSchema.safeParse({ kind: "favicon" }).success).toBe(false)
    })
})
