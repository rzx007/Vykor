import { lookup } from "node:dns/promises"
import { get as getHttp, type IncomingHttpHeaders } from "node:http"
import { get as getHttps } from "node:https"
import { Readable } from "node:stream"
import { net, session } from "electron"
import { parseRichHttpUrl } from "../../../shared/rich-ui-content"
import { isProxyOnly, isPublicAddress, isPublicHost } from "../../core/public-network"

const maxBytes = 5 * 1024 * 1024
const rasterImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"])
const redirects = new Set([301, 302, 303, 307, 308])
type ImageResponse = Readable & { headers: IncomingHttpHeaders; statusCode?: number }

function requestProxiedImage(
  url: URL,
  accept: string,
  signal: AbortSignal
): Promise<ImageResponse> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const request = net.request({
      url: url.href,
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
    const abort = () => request.abort()
    signal.addEventListener("abort", abort, { once: true })
    request.once("close", () => signal.removeEventListener("abort", abort))
    request.once("error", reject)
    request.once("abort", () => reject(signal.reason ?? new Error("图片请求已取消。")))
    request.once("redirect", (statusCode, _method, location) => {
      // Electron cancels this hop. The next request goes through source validation again.
      resolve(Object.assign(Readable.from([]), { statusCode, headers: { location } }))
    })
    request.once("response", (response) => {
      // Electron's response implements Readable, though its declaration only lists events.
      const stream = response as unknown as ImageResponse
      stream.once("close", abort)
      stream.once("aborted", () => stream.destroy(new Error("图片请求已取消。")))
      resolve(stream)
    })
    request.setHeader("Accept", accept)
    request.end()
  })
}

function firstHeader(response: ImageResponse, name: string): string | undefined {
  const value = response.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function requestImage(url: URL, signal: AbortSignal): Promise<ImageResponse> {
  if (!isPublicHost(url.hostname)) throw new Error("图片来源必须位于公开网络。")
  const headers = { Accept: [...rasterImages].join(", ") }
  if (isProxyOnly(await session.defaultSession.resolveProxy(url.href)))
    return requestProxiedImage(url, headers.Accept, signal)

  return new Promise((resolve, reject) => {
    const get = url.protocol === "http:" ? getHttp : getHttps
    get(
      url,
      {
        agent: false,
        signal,
        headers,
        lookup(hostname, options, callback) {
          void lookup(hostname, { all: true })
            .then((addresses) => {
              if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
                throw new Error("图片来源必须位于公开网络。")
              // Use the checked addresses on this connection. Do not resolve the host a second time.
              if (options.all) callback(null, addresses)
              else callback(null, addresses[0]!.address, addresses[0]!.family)
            })
            .catch((error: NodeJS.ErrnoException) => callback(error, "", 4))
        },
      },
      resolve
    ).once("error", reject)
  })
}

export async function fetchRichImage(source: string): Promise<string> {
  const signal = AbortSignal.timeout(12_000)
  let url = parseRichHttpUrl(source)
  for (let remaining = 3; url; remaining--) {
    const response = await requestImage(url, signal)
    try {
      const location = firstHeader(response, "location")
      if (redirects.has(response.statusCode ?? 0) && remaining > 0 && location) {
        url = parseRichHttpUrl(new URL(location, url).href)
        continue
      }
      if (response.statusCode !== 200) throw new Error("图片来源暂时无法访问。")
      const mime = firstHeader(response, "content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      if (!mime || !rasterImages.has(mime)) throw new Error("图片来源未返回支持的图片格式。")
      if (Number(firstHeader(response, "content-length")) > maxBytes)
        throw new Error("图片超过 5 MB。")
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response) {
        size += chunk.length
        if (size > maxBytes) throw new Error("图片超过 5 MB。")
        chunks.push(chunk)
      }
      if (!size) throw new Error("图片来源返回了空内容。")
      return `data:${mime};base64,${Buffer.concat(chunks, size).toString("base64")}`
    } finally {
      response.destroy()
    }
  }
  throw new Error("图片来源必须使用有效的 HTTP 或 HTTPS 地址。")
}
