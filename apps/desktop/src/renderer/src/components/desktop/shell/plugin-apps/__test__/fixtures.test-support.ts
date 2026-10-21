import type { PluginAppMount } from "@shared/plugin-app-types"
export const mount: PluginAppMount = { mountId: "mount", url: "vykor-plugin-app://frame/mount", state: {
  online: true, source: { sessionId: "original", appId: "app" }, availability: { canInvokeTools: true, canReadResource: true, canMessage: true },
  app: { id: "app", sessionId: "original", pluginId: "example", pluginVersion: "1", pluginDigest: "a", definitionDigest: "b", backendId: "editor", backendKind: "native-tools",
    resourceUri: "ui://editor", origin: { kind: "surface", surfaceId: "editor" }, logicalKey: "editor", status: "open", controlRevision: 2, createdAt: 1, updatedAt: 1 },
} }
