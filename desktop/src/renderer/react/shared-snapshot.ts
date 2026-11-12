/**
 * `next`, built afresh, with every part that holds the same values as `previous` replaced by `previous`'s object, down
 * through plain objects and arrays; anything else is the same only if it is the same object. A snapshot built again
 * with nothing changed is then `previous` itself, so the views kept for a repository draw nothing again when it shows,
 * and in one that did change, only the views of what changed draw again.
 */
export function sharedSnapshot<T>(previous: T | undefined, next: T): T {
    if (Object.is(previous, next) || !isPlain(previous) || !isPlain(next) || Array.isArray(previous) != Array.isArray(next))
        return next
    let previousRecord = previous as Record<string, unknown>
    let nextRecord = next as Record<string, unknown>
    let keys = Object.keys(nextRecord)
    let shared = Object.fromEntries(keys.map(key => [key, sharedSnapshot(previousRecord[key], nextRecord[key])]))
    let same = keys.length == Object.keys(previousRecord).length && keys.every(key => Object.hasOwn(previousRecord, key) && shared[key] === previousRecord[key])
    if (same)
        return previous
    if (keys.every(key => shared[key] === nextRecord[key]))
        return next
    return (Array.isArray(next) ? keys.map(key => shared[key]) : shared) as T
}

function isPlain(value: unknown): value is object {
    if (value == null || typeof value != "object")
        return false
    let prototype = Object.getPrototypeOf(value)
    return Array.isArray(value) || prototype == Object.prototype || prototype == null
}
