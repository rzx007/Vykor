import { createContext, useContext } from "react"
import type { PluginUiHost } from "./plugin-ui-provider"

export const PluginUiHostContext = createContext<PluginUiHost | null>(null)
export const usePluginUiHost = () => useContext(PluginUiHostContext)
