import { createHash, randomUUID } from "node:crypto";
import { PluginUiBridgeError, type PluginUiSurface } from "@vykor/client";

export const PLUGIN_UI_SCHEME = "vykor-plugin-ui";
export const PLUGIN_UI_DOCUMENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const PLUGIN_UI_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=()";
interface DocumentInput {
  ownerId: number; connection: object; sessionId: string; instanceId: string;
  componentDigest: string; surface: PluginUiSurface; html: string; sha256: string;
}
interface MountedDocument extends DocumentInput {
  mountId: string; url: string; phase: "registered" | "authorized" | "served";
}
export interface PluginUiDocumentRequest {
  ownerId?: number; url: string; method: string; resourceType: string;
  frameTreeNodeId?: number; parentFrameTreeNodeId?: number; mainFrameTreeNodeId?: number;
}
/** HTML stays in memory. Only browser-derived owner/frame facts authorize one load. */
export class PluginUiDocumentStore {
  private readonly documents = new Map<string, MountedDocument>();
  // Retired identities remain blocked until the actual frame disappears.
  private readonly frames = new Map<string, string>();
  constructor(private readonly onRevoke: (mountId: string, ownerId: number) => void = () => {}) {}
  register(input: DocumentInput): { mountId: string; url: string; instanceId: string } {
    if (Buffer.byteLength(input.html, "utf8") > 2 * 1024 * 1024)
      throw new PluginUiBridgeError("plugin_ui_payload_too_large");
    if (createHash("sha256").update(input.html, "utf8").digest("hex") !== input.sha256
      || !Number.isSafeInteger(input.ownerId) || input.ownerId < 1
      || !/^[0-9a-f]{64}$/i.test(input.componentDigest))
      throw new PluginUiBridgeError("plugin_ui_invalid_document");
    for (const doc of [...this.documents.values()]) {
      if (doc.ownerId === input.ownerId && (doc.instanceId === input.instanceId
        || (doc.surface === "session-sidebar" && input.surface === "session-sidebar"))) this.revoke(doc.mountId);
    }
    const owned = [...this.documents.values()].filter(doc => doc.ownerId === input.ownerId);
    if (owned.length >= 2) {
      const oldest = owned.find(doc => doc.surface !== "session-sidebar");
      if (!oldest) throw new PluginUiBridgeError("plugin_ui_unavailable");
      this.revoke(oldest.mountId);
    }
    const mountId = randomUUID();
    const url = PLUGIN_UI_SCHEME + "://frame/" + mountId;
    this.documents.set(mountId, { ...input, mountId, url, phase: "registered" });
    return { mountId, url, instanceId: input.instanceId };
  }
  authorizeRequest(request: PluginUiDocumentRequest): boolean {
    const doc = this.byUrl(request.url);
    if (!doc || request.url !== doc.url || doc.phase !== "registered"
      || doc.ownerId !== request.ownerId || request.method !== "GET" || request.resourceType !== "subFrame"
      || !Number.isSafeInteger(request.frameTreeNodeId) || request.frameTreeNodeId! < 1
      || request.parentFrameTreeNodeId === undefined || request.mainFrameTreeNodeId === undefined
      || request.parentFrameTreeNodeId !== request.mainFrameTreeNodeId
      || this.isPluginFrame(doc.ownerId, request.frameTreeNodeId!)) return false;
    doc.phase = "authorized";
    this.frames.set(this.frameKey(doc.ownerId, request.frameTreeNodeId!), doc.mountId);
    return true;
  }
  respond(request: Request): Response {
    const doc = this.byUrl(request.url);
    if (!doc || request.url !== doc.url || request.method !== "GET" || doc.phase !== "authorized")
      return new Response(null, { status: 404 });
    doc.phase = "served";
    return new Response(doc.html, { headers: {
      "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PLUGIN_UI_DOCUMENT_CSP,
      "Permissions-Policy": PLUGIN_UI_PERMISSIONS_POLICY, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } });
  }
  owns(mountId: string, ownerId: number, connection?: object): boolean {
    const doc = this.documents.get(mountId);
    return Boolean(doc && doc.ownerId === ownerId && (!connection || doc.connection === connection));
  }
  isPluginFrame(ownerId: number, frameTreeNodeId: number): boolean {
    return this.frames.has(this.frameKey(ownerId, frameTreeNodeId));
  }
  allowNavigation(ownerId: number, frameTreeNodeId: number, url: string, isMainFrame: boolean): boolean {
    if (isMainFrame) return !url.startsWith(PLUGIN_UI_SCHEME + ":");
    if (this.isPluginFrame(ownerId, frameTreeNodeId)) return false;
    if (!url.startsWith(PLUGIN_UI_SCHEME + ":")) return true;
    const doc = this.byUrl(url);
    return Boolean(doc && doc.ownerId === ownerId && doc.phase === "registered" && url === doc.url);
  }
  pruneFrames(ownerId: number, liveTreeNodeIds: number[]): void {
    const live = new Set(liveTreeNodeIds.map(id => this.frameKey(ownerId, id)));
    for (const [key, mountId] of this.frames) {
      if (key.startsWith(ownerId + ":") && !live.has(key)) {
        this.revoke(mountId); this.frames.delete(key);
      }
    }
  }
  revoke(mountId: string): void {
    const doc = this.documents.get(mountId);
    if (!doc) return;
    this.documents.delete(mountId);
    this.onRevoke(mountId, doc.ownerId);
  }
  revokeOwner(ownerId: number): void {
    for (const doc of [...this.documents.values()]) if (doc.ownerId === ownerId) this.revoke(doc.mountId);
    for (const key of this.frames.keys()) if (key.startsWith(ownerId + ":")) this.frames.delete(key);
  }
  clear(): void {
    for (const doc of [...this.documents.values()]) this.revoke(doc.mountId);
    // Loaded frames are still untrusted until their window/frame is destroyed.
  }
  private frameKey(ownerId: number, treeId: number): string { return ownerId + ":" + treeId; }
  private byUrl(url: string): MountedDocument | undefined {
    const match = /^vykor-plugin-ui:\/\/frame\/([0-9a-f-]{36})$/.exec(url);
    return match ? this.documents.get(match[1]!) : undefined;
  }
}
