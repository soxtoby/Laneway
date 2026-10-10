import { z } from "zod"

let RefValueSchema = z.object({ object: z.string(), symbolic: z.string().optional() })
let FileValueSchema = z.object({ object: z.string(), mode: z.number(), link: z.boolean() })
let IndexSchema = z.object({ object: z.string().nullable(), entries: z.string(), objects: z.array(z.string()) })
let StashSchema = z.object({ object: z.string(), message: z.string() })

export let NativeUndoSchema = z.object({
    cwd: z.string(),
    head: z.string().optional(),
    refs: z.array(z.object({ name: z.string(), before: RefValueSchema.nullable(), after: RefValueSchema.nullable() })),
    heads: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })),
    config: z.array(z.object({ key: z.string(), before: z.array(z.string()), after: z.array(z.string()) })),
    logs: z.array(z.object({ ref: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    files: z.array(z.object({ path: z.string(), before: FileValueSchema.nullable(), after: FileValueSchema.nullable() })),
    index: z.object({ before: IndexSchema, after: IndexSchema }).optional(),
    stashes: z.object({ before: z.array(StashSchema), after: z.array(StashSchema) }).optional(),
})

export type NativeUndo = z.infer<typeof NativeUndoSchema>
export type NativeIndex = z.infer<typeof IndexSchema>
export type NativeFile = z.infer<typeof FileValueSchema>
export type NativeRef = z.infer<typeof RefValueSchema>
