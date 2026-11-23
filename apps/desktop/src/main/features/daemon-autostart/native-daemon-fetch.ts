import { request } from "node:http"
import { Readable } from "node:stream"

// Private host routes reject browser request headers and redirects.
export const nativeDaemonFetch: typeof fetch = (url, options) =>
  new Promise<Response>((resolve, reject) => {
    const client = request(
      String(url),
      {
        method: options?.method,
        headers: Object.fromEntries(new Headers(options?.headers)),
        signal: options?.signal ?? undefined,
      },
      (incoming) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value)
        }
        const status = incoming.statusCode ?? 500
        const hasBody = status !== 204 && status !== 205 && status !== 304
        if (!hasBody) incoming.resume()
        resolve(
          new Response(hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null, {
            status,
            headers,
          })
        )
      }
    )
    client.once("error", reject)
    client.end(options?.body as string | undefined)
  })
