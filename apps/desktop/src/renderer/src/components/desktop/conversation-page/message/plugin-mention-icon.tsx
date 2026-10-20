import { createContext, useContext } from "react"
import type { DesktopPluginCatalogEntry } from "@shared/session-types"
import { ExtensionIcon } from "../../plugin-page/shared/plugin-catalog"

export const MessagePluginCatalog = createContext<readonly DesktopPluginCatalogEntry[]>([])

export function PluginMentionIcon({ pluginId }: { pluginId: string }): React.JSX.Element {
  const plugins = useContext(MessagePluginCatalog)
  const icon = plugins.find((plugin) => plugin.pluginId === pluginId)?.icon
  return (
    <span className="mr-1 inline-block align-middle">
      <ExtensionIcon name="plugin" src={icon} size="inline" />
    </span>
  )
}
