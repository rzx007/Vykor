import { isPluginIconSource, isPluginWebUrl } from "@rzx/client"

const MAX_BYTES = 512 * 1024

/** Download only image bytes; the renderer keeps its existing no-remote-images policy. */
export class PluginIconLoader {
  private readonly cache = new Map<string, { expires: number; value: Promise<string | null> }>()
  constructor(private readonly fetchImage: typeof fetch = fetch) {}

  load(input: { src: string }): Promise<string | null> {
    const src = input?.src
    if (typeof src !== "string" || !isPluginIconSource(src)) return Promise.resolve(null)
    if (!isPluginWebUrl(src)) return Promise.resolve(src)
    const cached = this.cache.get(src)
    if (cached && cached.expires > Date.now()) return cached.value
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
    const value = this.download(src).catch(() => null)
    this.cache.set(src, { expires: Date.now() + 5 * 60_000, value })
    return value
  }

  private async download(src: string): Promise<string | null> {
    const response = await this.fetchImage(src, {
      signal: AbortSignal.timeout(5_000),
      credentials: "omit",
      headers: { Accept: "image/*" },
    })
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (
      !response.ok ||
      !mime ||
      !/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mime) ||
      Number(response.headers.get("content-length")) > MAX_BYTES
    ) {
      await response.body?.cancel()
      return null
    }
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BYTES) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    if (!bytes) return null
    return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`
  }
}
