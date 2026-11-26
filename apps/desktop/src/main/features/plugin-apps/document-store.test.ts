import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { PluginAppDocumentStore } from "./document-store"
const html = "<!doctype html><input value='draft'>"
const input = { ownerId: 42, connection: {}, sessionId: "s", appId: "a", html, sha256: createHash("sha256").update(html).digest("hex") }
it("requires browser-derived frame ownership, rejects replay, and remembers retired identities", () => {
  const store = new PluginAppDocumentStore(), mounted = store.register(input)
  const request = { ownerId: 42, url: mounted.url, method: "GET", resourceType: "subFrame", frameTreeNodeId: 7, parentFrameTreeNodeId: 1, mainFrameTreeNodeId: 1 }
  for (const forged of [{ ownerId: 43 }, { frameTreeNodeId: undefined }, { parentFrameTreeNodeId: 2 }, { resourceType: "mainFrame" }, { url: mounted.url + "?appId=a" }])
    expect(store.authorizeRequest({ ...request, ...forged })).toBe(false)
  expect(store.respond(new Request(mounted.url)).status).toBe(404)
  expect(store.authorizeRequest(request)).toBe(true)
  expect(store.respond(new Request(mounted.url)).headers.get("Content-Security-Policy")).toContain("connect-src 'none'")
  expect(store.owns(mounted.mountId, 42, input.connection, true)).toBe(true)
  expect(store.authorizeRequest(request)).toBe(false)
  store.revoke(mounted.mountId)
  expect(store.isPluginFrame(42, 7)).toBe(true)
  expect(store.allowNavigation(42, 7, "about:blank", false)).toBe(false)
})
it("gives local previews their own quota without removing plugin drafts", () => {
  const store = new PluginAppDocumentStore()
  for (let i = 0; i < 4; i++) store.register({ ...input, appId: String(i), sessionId: null })
  expect(() => store.register({ ...input, appId: "preview", sessionId: null })).toThrow("capacity")
  for (let i = 0; i < 8; i++) store.register({ ...input, appId: String(i), sessionId: i < 4 ? "s" : "t" })
  expect(() => store.register({ ...input, appId: "9", sessionId: "u" })).toThrow("capacity")
  const other = store.register({ ...input, ownerId: 43 })
  expect(store.owns(other.mountId, 43)).toBe(true)
})
it("checks HTML digest and permits the larger 16 MiB app budget", () => {
  const store = new PluginAppDocumentStore()
  expect(() => store.register({ ...input, sha256: "0".repeat(64) })).toThrow("invalid_document")
  const large = "x".repeat(3 * 1024 * 1024)
  expect(store.register({ ...input, html: large, sha256: createHash("sha256").update(large).digest("hex") }).mountId).toBeTruthy()
})

it("allows any public HTTPS player and its CDN inside the mounted video frame only", () => {
  const store = new PluginAppDocumentStore()
  const embed = new URL("https://player.example.test/embed/video")
  const mounted = store.register({ ...input, sessionId: null }, embed.origin)
  expect(store.authorizeRequest({
    ownerId: 42, url: mounted.url, method: "GET", resourceType: "subFrame",
    frameTreeNodeId: 7, parentFrameTreeNodeId: 1, mainFrameTreeNodeId: 1,
  })).toBe(true)
  const csp = store.respond(new Request(mounted.url)).headers.get("Content-Security-Policy")
  expect(csp).toContain("frame-src https://player.example.test")
  expect(csp).toContain("default-src 'none'")
  const child = { ownerId: 42, frameTreeNodeId: 8, parentFrameTreeNodeId: 7, method: "GET" }
  const navigation = { ...child, resourceType: "subFrame", url: embed.href }
  expect(store.authorizeFrameRequest(navigation, 7)).toBe(true)
  expect(store.authorizeFrameRequest({ ...navigation, url: "https://other.example.test/player" }, 7)).toBe(false)
  const media = { ...child, resourceType: "media", url: "https://cdn.other.test/video.mp4" }
  expect(store.authorizeFrameRequest(media, 7)).toBe(true)
  expect(store.authorizeFrameRequest({ ...media, frameTreeNodeId: 7 }, 7)).toBe(false)
  expect(store.authorizeFrameRequest({ ...media, url: "https://127.0.0.1/video" }, 7)).toBe(false)
  store.revoke(mounted.mountId)
  expect(store.authorizeFrameRequest(navigation, 7)).toBe(false)
})
