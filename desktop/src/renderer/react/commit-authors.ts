import type { AuthorIdentitySettings } from "@laneway/shared"

/**
 * Whether an email is one of the developer's Author Identities. The history's emails are already mailmapped, and
 * the graph's identities include Git's configured email when no primary is set, so this matches the Engine's
 * involvement check: a case-insensitive comparison of whole addresses.
 */
export function authoredBy({ primary, secondary }: AuthorIdentitySettings, email: string) {
    let address = email.toLowerCase()
    return [primary, ...secondary].some(identity => identity?.toLowerCase() == address)
}

/** Up to two initials: the first and last words of the author's name, or the start of their email without a name. */
export function authorInitials(name: string, email: string) {
    let words = name.split(/\s+/).filter(Boolean)
    let picked = words.length > 1 ? [words[0]!, words.at(-1)!] : words.length == 1 ? words : [email]
    return picked.map(word => [...word][0] ?? "").join("").toLocaleUpperCase()
}
