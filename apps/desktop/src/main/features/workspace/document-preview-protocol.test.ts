import { beforeEach, expect, it, vi } from "vitest"
import { resolve } from "node:path"
import { net, protocol } from "electron"
import type { Session } from "electron"
import { installDocumentPreviewProtocol } from "./document-preview-protocol"

vi.mock("electron", () => ({ net: { fetch: vi.fn() }, protocol: { handle: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())

it("serves only bundled assets with offline CSP and opaque-frame CORS", async () => {
  vi.mocked(net.fetch).mockResolvedValue(
    new Response("bundle", { headers: { "Content-Type": "text/javascript" } })
  )
  installDocumentPreviewProtocol(
    { protocol } as unknown as Session,
    resolve("out/document-preview")
  )
  const handler = vi.mocked(protocol.handle).mock.calls[0]![1]
  const response = (await handler(new Request("vykor-preview://app/assets/main.js"))) as Response
  expect(await response.text()).toBe("bundle")
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "connect-src vykor-preview: blob:"
  )
  expect(response.headers.get("Content-Security-Policy")).not.toMatch(/https?:/)
  expect(net.fetch).toHaveBeenCalledWith(
    expect.stringMatching(/out\/document-preview\/assets\/main.js$/)
  )
})

it.each([
  ["vykor-preview://other/index.html", "GET"],
  ["vykor-preview://app/index.html", "POST"],
  ["vykor-preview://app/%2e%2e%2f%2e%2e%2fsecret.txt", "GET"],
  ["vykor-preview://app/%5csecret.txt", "GET"],
])("rejects paths and methods outside the static bundle: %s", async (url, method) => {
  installDocumentPreviewProtocol(
    { protocol } as unknown as Session,
    resolve("out/document-preview")
  )
  const handler = vi.mocked(protocol.handle).mock.calls[0]![1]
  const response = (await handler(new Request(url, { method }))) as Response
  expect(response.status).toBe(403)
  expect(net.fetch).not.toHaveBeenCalled()
})
