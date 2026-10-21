import { createHash, randomUUID } from "node:crypto"
import type { IsolatedDocumentRequest } from "./document-security"
import { ISOLATED_DOCUMENT_DOCUMENT_CSP, ISOLATED_DOCUMENT_PERMISSIONS_POLICY } from "./document-security"
export const PLUGIN_APP_SCHEME = "vykor-plugin-app"
interface DocumentInput { ownerId: number; connection: object; sessionId: string; appId: string; html: string; sha256: string }
interface Document extends DocumentInput { mountId: string; url: string; phase: "registered" | "authorized" | "served" }
export class PluginAppDocumentStore {
  private readonly documents = new Map<string, Document>()
  private readonly frames = new Map<string, string>()
  constructor(private readonly onRevoke: (mountId: string, ownerId: number) => void = () => {}) {}
  register(input: DocumentInput): { mountId: string; url: string } {
    if (Buffer.byteLength(input.html) > 16 * 1024 * 1024 || createHash("sha256").update(input.html).digest("hex") !== input.sha256)
      throw new Error("plugin_app_invalid_document")
    const owned = [...this.documents.values()].filter(doc => doc.ownerId === input.ownerId)
    if (owned.some(doc => doc.appId === input.appId && doc.sessionId === input.sessionId)) throw new Error("plugin_app_already_mounted")
    if (owned.length >= 8 || owned.filter(doc => doc.sessionId === input.sessionId).length >= 4) throw new Error("plugin_app_capacity_reached")
    const mountId = randomUUID(), url = `${PLUGIN_APP_SCHEME}://frame/${mountId}`
    this.documents.set(mountId, { ...input, mountId, url, phase: "registered" })
    return { mountId, url }
  }
  authorizeRequest(request: IsolatedDocumentRequest): boolean {
    const doc = this.byUrl(request.url)
    if (!doc || doc.phase !== "registered" || doc.ownerId !== request.ownerId || request.method !== "GET" || request.resourceType !== "subFrame"
      || !Number.isSafeInteger(request.frameTreeNodeId) || request.frameTreeNodeId! < 1
      || request.parentFrameTreeNodeId === undefined || request.parentFrameTreeNodeId !== request.mainFrameTreeNodeId
      || this.isPluginFrame(doc.ownerId, request.frameTreeNodeId!)) return false
    doc.phase = "authorized"
    this.frames.set(`${doc.ownerId}:${request.frameTreeNodeId}`, doc.mountId)
    return true
  }
  respond(request: Request): Response {
    const doc = this.byUrl(request.url)
    if (!doc || doc.phase !== "authorized" || request.method !== "GET") return new Response(null, { status: 404 })
    doc.phase = "served"
    return new Response(doc.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ISOLATED_DOCUMENT_DOCUMENT_CSP,
      "Permissions-Policy": ISOLATED_DOCUMENT_PERMISSIONS_POLICY + ", usb=(), serial=(), hid=(), midi=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=(), xr-spatial-tracking=()", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } })
  }
  owns(mountId: string, ownerId: number, connection?: object, served = false): boolean {
    const doc = this.documents.get(mountId)
    return !!doc && doc.ownerId === ownerId && (!connection || doc.connection === connection) && (!served || doc.phase === "served")
  }
  rebind(mountId: string, previous: object, next: object): void {
    const doc = this.documents.get(mountId)
    if (!doc || doc.connection !== previous) throw new Error("plugin_app_mount_closed")
    doc.connection = next
  }
  isPluginFrame(ownerId: number, frameId: number): boolean { return this.frames.has(`${ownerId}:${frameId}`) }
  allowNavigation(ownerId: number, frameId: number, url: string, isMainFrame: boolean): boolean {
    if (isMainFrame) return !url.startsWith(PLUGIN_APP_SCHEME + ":")
    const id = this.frames.get(`${ownerId}:${frameId}`)
    if (id) { const doc = this.documents.get(id); return !!doc && doc.phase === "served" && url.startsWith(doc.url + "#") }
    if (!url.startsWith(PLUGIN_APP_SCHEME + ":")) return true
    const doc = this.byUrl(url)
    return !!doc && doc.ownerId === ownerId && doc.phase === "registered"
  }
  pruneFrames(ownerId: number, liveIds: number[]): void {
    const live = new Set(liveIds.map(id => `${ownerId}:${id}`))
    for (const [key, id] of this.frames) if (key.startsWith(`${ownerId}:`) && !live.has(key)) { this.revoke(id); this.frames.delete(key) }
  }
  revoke(mountId: string): void {
    const doc = this.documents.get(mountId)
    if (doc) { this.documents.delete(mountId); this.onRevoke(mountId, doc.ownerId) }
  }
  revokeOwner(ownerId: number): void { for (const doc of this.documents.values()) if (doc.ownerId === ownerId) this.revoke(doc.mountId) }
  clear(): void { for (const doc of this.documents.values()) this.revoke(doc.mountId) }
  private byUrl(url: string): Document | undefined {
    const id = /^vykor-plugin-app:\/\/frame\/([0-9a-f-]{36})$/.exec(url)?.[1]
    return id ? this.documents.get(id) : undefined
  }
}
