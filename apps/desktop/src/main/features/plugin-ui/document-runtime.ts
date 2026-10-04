import { webContents } from "electron";
import { PluginUiDocumentStore } from "./document-store";
export const desktopPluginUiDocuments = new PluginUiDocumentStore((mountId, ownerId) => {
  const owner = webContents.fromId(ownerId);
  if (owner && !owner.isDestroyed()) owner.send("plugin-ui:revoked", { mountId });
});
