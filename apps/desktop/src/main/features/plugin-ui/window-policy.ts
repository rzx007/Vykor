import type { WebContents } from "electron";
import { PluginUiDocumentStore, PLUGIN_UI_SCHEME } from "./document-store";
export function isPluginUiExternalOpenBlocked(referrer: string): boolean {
  return referrer.startsWith(PLUGIN_UI_SCHEME + ":");
}
export function attachPluginUiWindowPolicy(contents: WebContents, store: PluginUiDocumentStore): () => void {
  const ownerId = contents.id;
  const browserSession = contents.session;
  const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
    try {
      if (!store.allowNavigation(ownerId, event.frame?.frameTreeNodeId ?? -1, event.url, event.isMainFrame))
        event.preventDefault();
    } catch { event.preventDefault(); }
  };
  const created = (): void => {
    try { store.pruneFrames(ownerId, contents.mainFrame.framesInSubtree.map(frame => frame.frameTreeNodeId)); }
    catch { /* A disappearing window is cleaned by the destroyed handler. */ }
  };
  const download = (event: Electron.Event, item: Electron.DownloadItem, source: WebContents): void => {
    if (source?.id === ownerId && (isPluginUiExternalOpenBlocked(item.getURL())
      || isPluginUiExternalOpenBlocked(item.getURLChain()[0] ?? ""))) event.preventDefault();
  };
  const dispose = (): void => {
    contents.off("will-frame-navigate", navigate);
    contents.off("frame-created", created);
    browserSession.off("will-download", download);
    store.revokeOwner(ownerId);
  };
  contents.on("will-frame-navigate", navigate);
  contents.on("frame-created", created);
  browserSession.on("will-download", download);
  contents.once("destroyed", dispose);
  return dispose;
}
