import { expect, it } from "vitest"
import { createHash } from "node:crypto"
import { PluginUiDocumentStore } from "./document-store"
it("keeps a still-live revoked owner frame isolated until actual frame destruction", () => {
  const store = new PluginUiDocumentStore()
  const html = "<p>live</p>"
  const mount = store.register({ ownerId: 42, connection: {}, sessionId: "session",
    instanceId: "10000000-0000-4000-8000-000000000001", componentDigest: "a".repeat(64),
    surface: "tool-result", html, sha256: createHash("sha256").update(html).digest("hex") })
  store.authorizeRequest({ ownerId: 42, url: mount.url, method: "GET", resourceType: "subFrame",
    frameTreeNodeId: 7, parentFrameTreeNodeId: 1, mainFrameTreeNodeId: 1 })
  store.respond(new Request(mount.url))
  store.revokeOwner(42)
  expect(store.isPluginFrame(42, 7)).toBe(true)
  for (const url of ["file:///private", "https://escape.invalid/", "about:blank", mount.url + "#next"])
    expect(store.allowNavigation(42, 7, url, false)).toBe(false)
  store.pruneFrames(42, [])
  expect(store.isPluginFrame(42, 7)).toBe(false)
})
