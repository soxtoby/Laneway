import { firstEmoji, monogramText, RepositoryIconSchema, repositoryInitials } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { iconLabel, loadIconCatalog, popularIcons, searchIcons } from "../src/renderer/react/icon-catalog"
import { expandAllNode } from "../src/renderer/react/icon-nodes"

describe("Application icons", () => {
    test("the diff's expand control draws Tabler's selector, as the column's Expand all does", async () => {
        let catalog = await loadIconCatalog()
        expect(expandAllNode).toEqual(catalog.nodes.selector!)
    })

    test("the icon catalogue loads once and searches names and tags", async () => {
        let catalog = await loadIconCatalog()
        expect(await loadIconCatalog()).toBe(catalog)
        expect(Object.keys(catalog.nodes).length).toBeGreaterThan(4000)
        // Every popular icon exists, so the empty query never shows gaps.
        expect(popularIcons.filter(name => !(name in catalog.nodes))).toEqual([])
        expect(searchIcons(catalog, "")).toEqual(popularIcons)
        expect(searchIcons(catalog, "git bra")[0]).toBe("git-branch")
        // "feline" is a tag on the cat icon rather than part of its name.
        expect(searchIcons(catalog, "feline")).toContain("cat")
        expect(searchIcons(catalog, "no such icon anywhere")).toEqual([])
        expect(iconLabel("device-gamepad-2")).toBe("Device gamepad 2")
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
