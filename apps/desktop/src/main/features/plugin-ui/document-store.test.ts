import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PluginUiDocumentStore, PLUGIN_UI_DOCUMENT_CSP } from "./document-store";

function fixture() {
  const store = new PluginUiDocumentStore();
  const html = "<p>isolated fixture</p>";
  const mounted = store.register({ ownerId: 42, connection: {}, sessionId: "session",
    instanceId: "10000000-0000-4000-8000-000000000001", componentDigest: "a".repeat(64),
    surface: "tool-result", html, sha256: createHash("sha256").update(html).digest("hex") });
  const request = { ownerId: 42, url: mounted.url, method: "GET", resourceType: "subFrame",
    frameTreeNodeId: 7, parentFrameTreeNodeId: 1, mainFrameTreeNodeId: 1 };
  return { store, html, mounted, request };
}

it("serves the verified memory document exactly once to its owning child frame", async () => {
  const f = fixture();
  expect(f.store.respond(new Request(f.mounted.url)).status).toBe(404);
  expect(f.store.authorizeRequest(f.request)).toBe(true);
  const response = f.store.respond(new Request(f.mounted.url));
  expect(await response.text()).toBe(f.html);
  expect(response.headers.get("Content-Security-Policy")).toBe(PLUGIN_UI_DOCUMENT_CSP);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(f.store.respond(new Request(f.mounted.url)).status).toBe(404);
  expect(f.store.authorizeRequest(f.request)).toBe(false);
  expect(f.store.isPluginFrame(42, 7)).toBe(true);
});

it.each([
  { ownerId: 43 }, { resourceType: "mainFrame" }, { resourceType: "xhr" }, { method: "POST" },
  { frameTreeNodeId: undefined }, { parentFrameTreeNodeId: 2 },
])("does not authorize missing/wrong requester facts %j", changes => {
  const f = fixture();
  expect(f.store.authorizeRequest({ ...f.request, ...changes })).toBe(false);
  expect(f.store.respond(new Request(f.mounted.url)).status).toBe(404);
});

it("refuses queries, alternate mounts and replay navigation, leaving same-document fragments to Chromium", () => {
  const f = fixture();
  for (const url of [f.mounted.url + "?data=secret", f.mounted.url + "#first-load",
    "file:///private", "https://example.invalid/", f.mounted.url.replace("frame/", "other/")])
    expect(f.store.authorizeRequest({ ...f.request, url })).toBe(false);
  expect(f.store.allowNavigation(42, 7, f.mounted.url, false)).toBe(true);
  expect(f.store.authorizeRequest(f.request)).toBe(true);
  f.store.respond(new Request(f.mounted.url));
  for (const url of [f.mounted.url, "data:text/html,escape", "javascript:alert(1)", "about:blank"])
    expect(f.store.allowNavigation(42, 7, url, false)).toBe(false);
  expect(f.store.allowNavigation(42, 1, "https://normal-host-link.invalid/", true)).toBe(true);
  expect(f.store.allowNavigation(42, 1, f.mounted.url, true)).toBe(false);
});

it("revokes documents but remembers retired frame identities until they are destroyed", () => {
  const f = fixture();
  f.store.authorizeRequest(f.request);
  f.store.respond(new Request(f.mounted.url));
  f.store.revoke(f.mounted.mountId);
  expect(f.store.respond(new Request(f.mounted.url)).status).toBe(404);
  expect(f.store.isPluginFrame(42, 7)).toBe(true);
  expect(f.store.allowNavigation(42, 7, "https://escape.invalid/", false)).toBe(false);
  f.store.revokeOwner(42);
  expect(f.store.isPluginFrame(42, 7)).toBe(false);
});

it("bounds HTML and verifies bytes rather than trusting a caller-supplied digest", () => {
  const f = fixture();
  const base = { ownerId: 42, connection: {}, sessionId: "session", instanceId: f.mounted.instanceId,
    componentDigest: "a".repeat(64), surface: "tool-result" as const };
  expect(() => f.store.register({ ...base, html: "different", sha256: "b".repeat(64) })).toThrow("plugin_ui_invalid_document");
  expect(() => f.store.register({ ...base, html: "中".repeat(700_000), sha256: "b".repeat(64) })).toThrow("plugin_ui_payload_too_large");
});
