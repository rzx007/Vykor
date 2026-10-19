import { net, protocol, type Session } from "electron"
import { resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const scheme = "vykor-preview"
export const DOCUMENT_PREVIEW_CSP =
  "default-src 'none'; script-src vykor-preview:; style-src vykor-preview: 'unsafe-inline'; img-src vykor-preview: data: blob:; font-src vykor-preview: data: blob:; connect-src vykor-preview: blob:; worker-src vykor-preview: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export function registerDocumentPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

// Only serves the application's static preview bundle, never user file paths.
export function installDocumentPreviewProtocol(browserSession: Session, directory: string): void {
  browserSession.protocol.handle(scheme, async (request) => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname)
      if (request.method !== "GET" || url.host !== "app" || path.includes("\\"))
        return new Response(null, { status: 403 })
      const root = resolve(directory)
      const file = resolve(root, "." + path)
      if (!file.startsWith(root + sep)) return new Response(null, { status: 403 })
      const response = await net.fetch(pathToFileURL(file).href)
      const headers = new Headers(response.headers)
      headers.set("Access-Control-Allow-Origin", "*")
      headers.set("Content-Security-Policy", DOCUMENT_PREVIEW_CSP)
      headers.set("X-Content-Type-Options", "nosniff")
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
