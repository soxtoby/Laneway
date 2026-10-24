import { z } from "zod"

/** The palette shared by icon and monogram overrides; each name maps to a light and a dark tone in the renderer. */
export const repositoryIconColors = [
    "gray",
    "red",
    "orange",
    "amber",
    "yellow",
    "lime",
    "green",
    "emerald",
    "teal",
    "cyan",
    "sky",
    "blue",
    "indigo",
    "violet",
    "purple",
    "fuchsia",
    "pink",
    "rose",
] as const

export type RepositoryIconColor = typeof repositoryIconColors[number]

/**
 * A user's Repository Icon override. Icons are Tabler names in kebab case; an image is an absolute
 * path read on demand so the file never has to be copied into application data.
 */
export type RepositoryIcon =
    | { kind: "icon"; name: string; color: RepositoryIconColor }
    | { kind: "emoji"; emoji: string }
    | { kind: "monogram"; text: string; color: RepositoryIconColor }
    | { kind: "image"; path: string }

/** Everything the user can change about how a repository is labelled in Laneway. */
export interface RepositoryIdentity {
    /** Replaces the folder name in navigation; the folder itself is untouched. */
    label?: string
    icon?: RepositoryIcon
}

export const repositoryImageExtensions = ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"] as const

/** An image file inside a repository that could serve as its icon. */
export interface RepositoryImageFile {
    path: string
    /** Forward-slash path from the Main Worktree, for display and search. */
    relative: string
}

export let RepositoryIconColorSchema = z.enum(repositoryIconColors)

let trimmed = z.string().trim().min(1)

export let RepositoryIconSchema: z.ZodType<RepositoryIcon> = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("icon"), name: trimmed.max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), color: RepositoryIconColorSchema }),
    z.object({ kind: z.literal("emoji"), emoji: trimmed.max(32) }),
    // One or two graphemes of letters or numbers, with combining marks and joiners allowed inside.
    z.object({ kind: z.literal("monogram"), text: trimmed.max(32).regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}‌‍]*$/u), color: RepositoryIconColorSchema }),
    z.object({ kind: z.literal("image"), path: trimmed.max(1024).regex(new RegExp(`\\.(?:${repositoryImageExtensions.join("|")})$`, "i")) }),
])

export let RepositoryLabelSchema = z.string().trim().min(1).max(120)

let segmenter = typeof Intl.Segmenter == "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined

/** Splits text into user-perceived characters, so "é" or an emoji with modifiers is one. */
export function graphemes(text: string) {
    return segmenter ? [...segmenter.segment(text)].map(part => part.segment) : [...text]
}

export function graphemeCount(text: string) {
    return graphemes(text).length
}

/** The normalized monogram text, or nothing when it is not one or two letters or numbers. */
export function monogramText(text: string) {
    let normalized = text.normalize("NFKC").trim().toLocaleUpperCase()
    let parsed = RepositoryIconSchema.safeParse({ kind: "monogram", text: normalized, color: "gray" })
    return parsed.success && graphemeCount(normalized) <= 2 ? normalized : undefined
}

/** The first emoji in pasted text, so a whole message pasted into the field still yields one glyph. */
export function firstEmoji(text: string) {
    let trimmed = text.trim()
    if (!trimmed)
        return undefined
    let segment = segmenter ? segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment : [...trimmed][0]
    if (!segment)
        return undefined
    let flag = /^\p{Regional_Indicator}{2}$/u.test(segment)
    let keycap = /^[#*0-9]️?⃣$/u.test(segment)
    return /\p{Extended_Pictographic}/u.test(segment) || flag || keycap ? segment : undefined
}

/** Two initials from a repository name: the first letters of its first two words, or its first two characters. */
export function repositoryInitials(name: string) {
    let words = name.split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toLocaleUpperCase()
}

export function isRepositoryImagePath(path: string) {
    return RepositoryIconSchema.safeParse({ kind: "image", path }).success
}
