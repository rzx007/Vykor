import type { DesktopPluginAppsAPI } from "@shared/plugin-app-types"
/** Coarsens trusted host invalidations to the notification supported by official SDK 1.1.2. */
export function attachResourceFeed(api: DesktopPluginAppsAPI, mountId: string, invalidate: () => void): () => void {
  return api.onResourcesChanged?.(notice => { if (notice.mountId === mountId) invalidate() }) ?? (() => {})
}
