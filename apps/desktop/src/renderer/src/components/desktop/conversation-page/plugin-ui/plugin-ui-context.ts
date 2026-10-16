import { createContext, useContext } from "react"
import type { PluginUiInstanceRecord, PluginUiSurface } from "@vykor/client"
import type { DesktopSessionView } from "@shared/session-types"
import type { DesktopPluginUiMountResult } from "@shared/plugin-ui-types"
import type { PluginUiConfirmationDetails } from "./plugin-ui-confirmation"
import type { usePluginUiConversation } from "./use-plugin-ui-conversation"

export interface PluginUiDisplay {
  key: string
  instance: PluginUiInstanceRecord
  surface: PluginUiSurface
}

export interface PluginUiMountLease {
  result: Promise<DesktopPluginUiMountResult>
  release(): Promise<void>
}

export interface PluginUiHost {
  available: boolean
  view: DesktopSessionView | null
  displays: PluginUiDisplay[]
  isCurrent(instanceId: string): boolean
  mount(display: PluginUiDisplay): PluginUiMountLease
  open(
    instance: PluginUiInstanceRecord,
    surface: PluginUiSurface,
    opener?: HTMLElement,
    forceReload?: boolean
  ): void
  close(instanceId: string, focus?: boolean): void
  confirm(details: PluginUiConfirmationDetails, signal: AbortSignal): Promise<void>
  requestConversation: ReturnType<typeof usePluginUiConversation>["request"]
  conversationStatus: ReturnType<typeof usePluginUiConversation>["status"]
  queryConversation: ReturnType<typeof usePluginUiConversation>["query"]
}

// 两个订阅范围共用类型入口：Frame 读取实时会话，工具面板只读取显示状态。
// 合并模块不合并 Context，避免文本增量重新带动整个工具面板。
export const PluginUiHostContext = createContext<PluginUiHost | null>(null)
export const PluginUiDisplaysContext = createContext<Pick<
  PluginUiHost,
  "displays" | "close"
> | null>(null)
export const usePluginUiHost = () => useContext(PluginUiHostContext)
export const usePluginUiDisplays = () => useContext(PluginUiDisplaysContext)
