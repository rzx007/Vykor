import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import { expect, it } from "vitest";
import { PluginUiDocumentStore } from "./document-store";
import { attachPluginUiWindowPolicy } from "./window-policy";

it("blocks registered frame navigation but preserves normal host navigation and cleans a destroyed owner", () => {
  const store = new PluginUiDocumentStore();
  const browserSession = new EventEmitter();
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), { id: 42,
    mainFrame: { framesInSubtree: [{ frameTreeNodeId: 1 }, { frameTreeNodeId: 7 }] } });
  Object.defineProperty(contents, "session", { get: () => {
    if (destroyed) throw new Error("Object has been destroyed");
    return browserSession;
  } });
  const html = "<p>frame</p>";
  const mount = store.register({ ownerId: 42, connection: {}, sessionId: "session",
    instanceId: "10000000-0000-4000-8000-000000000001", componentDigest: "a".repeat(64),
    surface: "tool-result", html, sha256: createHash("sha256").update(html).digest("hex") });
  store.authorizeRequest({ ownerId: 42, url: mount.url, method: "GET", resourceType: "subFrame",
    frameTreeNodeId: 7, parentFrameTreeNodeId: 1, mainFrameTreeNodeId: 1 });
  store.respond(new Request(mount.url));
  attachPluginUiWindowPolicy(contents as unknown as WebContents, store);
  const navigation = (tree: number, main: boolean) => {
    let blocked = false;
    contents.emit("will-frame-navigate", { frame: { frameTreeNodeId: tree },
      url: "https://normal-host.invalid/", isMainFrame: main, preventDefault: () => { blocked = true; } });
    return blocked;
  };
  expect(navigation(7, false)).toBe(true);
  expect(navigation(1, true)).toBe(false);
  contents.emit("frame-created");
  expect(store.isPluginFrame(42, 7)).toBe(true);
  destroyed = true;
  expect(() => contents.emit("destroyed")).not.toThrow();
  expect(store.owns(mount.mountId, 42)).toBe(false);
  expect(store.isPluginFrame(42, 7)).toBe(false);
});
