import type { Session } from "electron"

export interface IsolatedDocumentPolicy {
  authorizeRequest(request: IsolatedDocumentRequest): boolean
  isPluginFrame(ownerId: number, frameTreeNodeId: number): boolean
}
const policies = new WeakMap<Session, Map<string, IsolatedDocumentPolicy>>()
/** Electron permits one listener per session. All isolated schemes share this owner. */
export function registerIsolatedDocumentPolicy(
  session: Session,
  scheme: string,
  policy: IsolatedDocumentPolicy
): void {
  let entries = policies.get(session)
  if (!entries) {
    entries = new Map()
    policies.set(session, entries)
    const registered = entries
    session.webRequest.onBeforeRequest((details, callback) => {
      let cancel = false
      try {
        const frame = details.frame
        const owner = details.webContentsId
        const target = registered.get(new URL(details.url).protocol.slice(0, -1))
        // A registered app frame cannot load another app's scheme or a nested frame.
        const isolated =
          owner !== undefined &&
          frame &&
          [...registered.values()].some(
            (value) =>
              value.isPluginFrame(owner, frame.frameTreeNodeId) ||
              (frame.parent && value.isPluginFrame(owner, frame.parent.frameTreeNodeId))
          )
        if (isolated) cancel = true
        else if (target)
          cancel = !target.authorizeRequest({
            ownerId: owner,
            url: details.url,
            method: details.method,
            resourceType: details.resourceType,
            frameTreeNodeId: frame?.frameTreeNodeId,
            parentFrameTreeNodeId: frame?.parent?.frameTreeNodeId,
            mainFrameTreeNodeId: details.webContents?.mainFrame.frameTreeNodeId,
          })
      } catch {
        cancel = true
      }
      callback({ cancel })
    })
  }
  const prior = entries.get(scheme)
  if (prior && prior !== policy) throw new Error("isolated_document_policy_already_registered")
  entries.set(scheme, policy)
}

export const ISOLATED_DOCUMENT_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src data:; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
export const ISOLATED_DOCUMENT_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=()"
export interface IsolatedDocumentRequest {
  ownerId?: number
  url: string
  method: string
  resourceType: string
  frameTreeNodeId?: number
  parentFrameTreeNodeId?: number
  mainFrameTreeNodeId?: number
}
