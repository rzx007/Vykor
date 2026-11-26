import { lookup } from "node:dns/promises"
import { session, type Session } from "electron"
import { isProxyOnly, isPublicAddress, isPublicHttpsUrl } from "../../core/public-network"
import { desktopPluginAppDocuments } from "../plugin-apps/document-protocol"
import { isolatedDocumentRequest } from "../plugin-apps/document-security"

const YOUTUBE_ORIGIN = "https://www.youtube-nocookie.com"
const YOUTUBE_APP_REFERRER = "https://app.vykor.desktop/"

export function installYouTubeReferrer(network: Session): void {
  network.webRequest.onBeforeSendHeaders({ urls: [`${YOUTUBE_ORIGIN}/embed/*`] }, (details, done) => {
    const { requestHeaders } = details
    try {
      const request = isolatedDocumentRequest(details)
      const parent = request.parentFrameTreeNodeId
      if (
        request.resourceType === "subFrame" &&
        parent !== undefined &&
        desktopPluginAppDocuments.authorizeFrameRequest(request, parent)
      ) {
        for (const name of Object.keys(requestHeaders)) {
          if (name.toLowerCase() === "referer") delete requestHeaders[name]
        }
        requestHeaders.Referer = YOUTUBE_APP_REFERRER
      }
      done({ requestHeaders })
    } catch {
      done({ cancel: true })
    }
  })
}

export async function resolveVideoEmbed(source: string): Promise<URL> {
  const url = new URL(source)
  const { hostname, pathname } = url
  if (
    hostname === "youtu.be" ||
    ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(hostname)
  ) {
    const id = url.searchParams.get("v") ?? pathname.split("/").at(-1) ?? ""
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) return new URL(`${YOUTUBE_ORIGIN}/embed/${id}`)
  }
  if (hostname === "www.bilibili.com" || hostname === "bilibili.com") {
    const id = /^\/video\/(BV[A-Za-z0-9]+)\/?$/.exec(pathname)?.[1]
    if (id) return new URL(`https://player.bilibili.com/player.html?bvid=${id}&autoplay=0`)
  }
  if (!isPublicHttpsUrl(url)) throw new Error("视频来源必须位于公开网络。")
  if (isProxyOnly(await session.defaultSession.resolveProxy(url.href))) return url
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ""), { all: true })
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("视频来源必须位于公开网络。")
  }
  return url
}

export function videoPreviewHtml(url: URL): string {
  const src = url.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}
</style></head><body><iframe title="视频播放器" src="${src}" credentialless
 sandbox="allow-scripts allow-same-origin allow-presentation"
 referrerpolicy="no-referrer" allow="encrypted-media; picture-in-picture"
></iframe></body></html>`
}
