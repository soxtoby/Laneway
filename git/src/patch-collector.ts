import type { DiffLine } from "@laneway/shared"
import { createHash } from "node:crypto"
import { StringDecoder } from "node:string_decoder"

// Retain one page, even when Git produces a multi-gigabyte patch or one huge line.
export function patchCollector(offset: number, plain: boolean) {
    let digest = createHash("sha256")
    let decoder = new StringDecoder("utf8")
    let validator = new TextDecoder("utf-8", { fatal: true })
    let lines: DiffLine[] = []
    let summary: string[] = []
    let pending = "", skipping = false, oversized = false, binary = false, invalidEncoding = false, inHunk = false
    let oldLine = 0, newLine = 0, hunk = -1, count = 0

    let accept = (kind: DiffLine["kind"], text: string, old?: number, next?: number) => {
        let id = count++
        if (id >= offset && lines.length < 2000)
            lines.push({ id, kind, text, hunk, ...(old != undefined ? { oldLine: old } : {}), ...(next != undefined ? { newLine: next } : {}) })
    }
    let line = (text: string) => {
        if (plain) {
            if (text.includes("\0"))
                binary = true
            accept("context", text, undefined, ++newLine)
            return
        }
        let match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
        if (match) {
            oldLine = Number(match[1])
            newLine = Number(match[2])
            hunk++
            inHunk = true
            accept("hunk", text)
        } else if (text.startsWith("diff --git "))
            inHunk = false
        else if (inHunk && text[0] == "+")
            accept("addition", text.slice(1), undefined, newLine++)
        else if (inHunk && text[0] == "-")
            accept("deletion", text.slice(1), oldLine++)
        else if (inHunk && text[0] == " ")
            accept("context", text.slice(1), oldLine++, newLine++)
        else if (text.startsWith("\\ No newline"))
            accept("notice", text)
        else if (text.startsWith("Binary files ") || text == "GIT binary patch") {
            binary = true
            summary.push("Binary content changed.")
        } else if (/^similarity index/.test(text) && summary.length < 20) {
            summary.push(text)
        }
    }
    let consume = (text: string) => {
        for (let part of text.split(/(?<=\n)/)) {
            if (!skipping)
                pending += part
            if (pending.length > 16384) {
                oversized = true
                pending = pending.slice(0, 16384)
                skipping = true
            }
            if (part.endsWith("\n")) {
                line(skipping ? `${pending} [line truncated]` : pending.slice(0, -1))
                pending = ""
                skipping = false
            }
        }
    }

    return {
        summary,
        write(chunk: Buffer) {
            digest.update(chunk)
            if (!invalidEncoding) {
                try {
                    validator.decode(chunk, { stream: true })
                } catch {
                    invalidEncoding = true
                }
            }
            consume(decoder.write(chunk))
        },
        finish() {
            if (!invalidEncoding) {
                try {
                    validator.decode()
                } catch {
                    invalidEncoding = true
                }
            }
            consume(decoder.end())
            if (pending)
                line(pending)
            if (oversized)
                summary.push("Very long lines are abbreviated. Line selection is unavailable.")
            if (invalidEncoding)
                summary.push("Content is not UTF-8. Line selection is unavailable.")

            return {
                lines: binary && plain ? [] : lines,
                more: !(binary && plain) && count > offset + lines.length,
                digest: digest.digest("hex"),
                binary,
                oversized: oversized || invalidEncoding,
            }
        },
    }
}
