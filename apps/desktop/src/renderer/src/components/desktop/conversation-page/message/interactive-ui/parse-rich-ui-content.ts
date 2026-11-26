import { richUiContentSchema, type RichUiContent } from "@shared/rich-ui-content"

const components = {
  Image: ["image", "url"],
  Video: ["video", "url"],
  HtmlView: ["html", "html"],
} as const

export function parseRichUiContent(source: string): RichUiContent | null {
  if (source.length > 16_000 || /[\r\n]/.test(source)) return null
  const call = /^root = (Image|Video|HtmlView)\((.*)\)$/su.exec(source.trim())
  if (!call) return null

  try {
    const args: unknown[] = JSON.parse(`[${call[2]}]`)
    if (args.length !== 2) return null
    const [title, value] = args
    const [kind, field] = components[call[1] as keyof typeof components]
    const parsed = richUiContentSchema.safeParse({ kind, title, [field]: value })
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
