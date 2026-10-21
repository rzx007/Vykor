import { protocol, webContents, type Session } from "electron"
import { PluginAppDocumentStore, PLUGIN_APP_SCHEME } from "./document-store"
import { registerIsolatedDocumentPolicy } from "./document-security"
export const desktopPluginAppDocuments = new PluginAppDocumentStore((mountId, ownerId) => {
  const owner = webContents.fromId(ownerId)
  if (owner && !owner.isDestroyed()) owner.send("plugin-apps:revoked", { mountId })
})
export function registerPluginAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_APP_SCHEME, privileges: { standard: true, secure: true } }])
}
export function installPluginAppDocumentProtocol(store: PluginAppDocumentStore, session: Session): void {
  session.protocol.handle(PLUGIN_APP_SCHEME, request => store.respond(request))
  registerIsolatedDocumentPolicy(session, PLUGIN_APP_SCHEME, store)
}
