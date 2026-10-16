import { createContext, useContext } from "react"
import type { PluginUiDisplay } from "./plugin-ui-provider"

// 工具面板只需要显示列表和关闭操作，不随每个文本增量订阅整份会话。
export const PluginUiDisplaysContext = createContext<{
  displays: PluginUiDisplay[]
  close(instanceId: string, focus?: boolean): void
} | null>(null)

export const usePluginUiDisplays = () => useContext(PluginUiDisplaysContext)
