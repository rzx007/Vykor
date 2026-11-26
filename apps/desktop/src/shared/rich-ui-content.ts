import { z } from "zod/v4"

const title = z.string().trim().min(1).max(160)

export function parseRichHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    const web = url.protocol === "http:" || url.protocol === "https:"
    return web && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

export const richUiContentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      title,
      url: z.string().max(2048).refine(parseRichHttpUrl),
    })
    .strict(),
  z
    .object({
      kind: z.literal("video"),
      title,
      url: z
        .string()
        .max(2048)
        .refine((value) => parseRichHttpUrl(value)?.protocol === "https:"),
    })
    .strict(),
  z.object({ kind: z.literal("html"), title, html: z.string().min(1).max(15_000) }).strict(),
])

export type RichUiContent = z.infer<typeof richUiContentSchema>
export type RichUiLoadResult =
  | { kind: "disabled" }
  | { kind: "image"; src: string }
  | { kind: "frame"; mountId: string }
