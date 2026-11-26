import type { Session } from "electron"

export interface IsolatedDocumentPolicy {
  authorizeRequest(request: IsolatedDocumentRequest): boolean
  isPluginFrame(ownerId: number, frameTreeNodeId: number): boolean
  authorizeFrameRequest?(request: IsolatedDocumentRequest, isolatedFrameId: number): boolean
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
        const request = isolatedDocumentRequest(details)
        let isolated: IsolatedDocumentPolicy | undefined
        let isolatedFrameId: number | undefined
        if (owner !== undefined) {
          for (let current = frame; current && !isolated; current = current.parent) {
            const frameId = current.frameTreeNodeId
            isolated = [...registered.values()].find(policy => policy.isPluginFrame(owner, frameId))
            if (isolated) isolatedFrameId = frameId
          }
        }
        if (isolated && isolatedFrameId !== undefined)
          cancel = !!target || isolated.authorizeFrameRequest?.(request, isolatedFrameId) !== true
        else if (target) cancel = !target.authorizeRequest(request)
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

export function isolatedDocumentRequest(details: Pick<Electron.OnBeforeRequestListenerDetails,
  "webContentsId" | "url" | "method" | "resourceType" | "frame" | "webContents"
>): IsolatedDocumentRequest {
  return {
    ownerId: details.webContentsId,
    url: details.url,
    method: details.method,
    resourceType: details.resourceType,
    frameTreeNodeId: details.frame?.frameTreeNodeId,
    parentFrameTreeNodeId: details.frame?.parent?.frameTreeNodeId,
    mainFrameTreeNodeId: details.webContents?.mainFrame.frameTreeNodeId,
  }
}
