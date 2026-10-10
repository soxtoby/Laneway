import { parseArgs } from "node:util"

export class UsageError extends Error {}

export interface Arguments {
    positionals: string[]
    values: Record<string, string | boolean | string[] | undefined>
}

export let commonOptions = { json: "boolean", "git-path": "string", "no-wait": "boolean", directory: "string", help: "boolean" } as const

export function parseArguments(args: string[], definitions: Record<string, "string" | "boolean" | "multiple">): Arguments {
    let all: Record<string, "string" | "boolean" | "multiple"> = { ...commonOptions, ...definitions }
    let options = Object.fromEntries(
        Object.entries(all).map(([name, type]) => {
            let short = ({ directory: "C", help: "h", message: "m", "message-file": "F" } as Record<string, string>)[name]
            return [name, {
                type: type == "multiple" ? "string" as const : type,
                multiple: type == "multiple",
                ...(short ? { short } : {}),
            }]
        }),
    )
    try {
        return parseArgs({ args, options, allowPositionals: true }) as Arguments
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
    }
}

export function option(args: Arguments, name: string) {
    let value = args.values[name]
    return typeof value == "string" ? value : undefined
}

export function requiredOption(args: Arguments, name: string) {
    let value = option(args, name)
    if (!value)
        throw new UsageError(`Provide --${name}.`)
    return value
}

export function flag(args: Arguments, name: string) {
    return args.values[name] == true
}

export function multiple(args: Arguments, name: string) {
    let value = args.values[name]
    return Array.isArray(value) ? value : []
}

export function operands(args: Arguments, minimum: number, maximum = minimum) {
    if (args.positionals.length < minimum || args.positionals.length > maximum) {
        throw new UsageError(
            `Expected ${
                minimum == maximum ? minimum : `${minimum}–${maximum}`
            } positional argument(s); received ${args.positionals.length}. Use --help for syntax.`,
        )
    }
    return args.positionals
}
