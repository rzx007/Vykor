import type {
  DesktopPluginCatalogEntry,
  DesktopSessionRecord,
  DesktopSessionRun,
} from "@shared/session-types"

export function resolveComposerPluginSelection(
  session: DesktopSessionRecord | null | undefined,
  runs: readonly DesktopSessionRun[],
  catalog: readonly DesktopPluginCatalogEntry[]
): {
  pluginAutoSelectionEnabled: boolean
  manualPluginName: string | null
  automaticPluginName: string | null
} {
  const runtime = session?.metadata.runtime as Record<string, unknown> | undefined
  const manualId = session?.metadata.activePluginId
  const latestRun =
    runs.find((run) => run.status === "running") ??
    runs.reduce<DesktopSessionRun | undefined>(
      (latest, run) => (!latest || run.createdAt > latest.createdAt ? run : latest),
      undefined
    )
  const selection = latestRun?.metadata.pluginSelection as Record<string, unknown> | undefined
  const automaticId =
    selection?.status === "resolved" && selection.source === "auto" && selection.scopeVersion !== 2 && !Array.isArray(selection.pluginIds)
      ? selection.pluginId : null
  const name = (id: unknown): string | null =>
    typeof id === "string" && id.trim()
      ? (catalog.find((plugin) => plugin.pluginId === id)?.displayName ?? id)
      : null
  return {
    pluginAutoSelectionEnabled: runtime?.pluginAutoSelectionEnabled !== false,
    manualPluginName: name(manualId),
    automaticPluginName: name(automaticId),
  }
}
