import { protocol, type Session } from "electron";
import { PluginUiDocumentStore, PLUGIN_UI_SCHEME } from "./document-store";
let registered = false;
const installed = new WeakSet<Session>();
export function registerPluginUiScheme(): void {
  if (registered) return;
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_UI_SCHEME, privileges: { standard: true, secure: true } }]);
  registered = true;
}
export function installPluginUiDocumentProtocol(store: PluginUiDocumentStore, browserSession: Session): void {
  if (installed.has(browserSession)) return;
  browserSession.protocol.handle(PLUGIN_UI_SCHEME, request => store.respond(request));
  // This session currently has no other onBeforeRequest owner; keep one shared policy.
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    let cancel = false;
    try {
      const frame = details.frame;
      const owner = details.webContentsId;
      if (details.url.startsWith(PLUGIN_UI_SCHEME + ":")) {
        cancel = !store.authorizeRequest({
          ownerId: owner, url: details.url, method: details.method, resourceType: details.resourceType,
          frameTreeNodeId: frame?.frameTreeNodeId, parentFrameTreeNodeId: frame?.parent?.frameTreeNodeId,
          mainFrameTreeNodeId: details.webContents?.mainFrame.frameTreeNodeId,
        });
      } else if (owner !== undefined && frame && store.isPluginFrame(owner, frame.frameTreeNodeId)) cancel = true;
    } catch { cancel = true; }
    callback({ cancel });
  });
  installed.add(browserSession);
}
export function pluginUiDocumentProtocolAvailable(browserSession: Session): boolean {
  return registered && installed.has(browserSession);
}
