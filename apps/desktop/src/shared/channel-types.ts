import type {
  ChannelDenialNotice,
  ChannelRuntimeStatus,
  FeishuChannelSnapshot,
  FeishuRegistrationSnapshot,
} from "@vykor/client"

export type ChannelDomain = "feishu" | "lark"

export interface DesktopConnectionsSnapshot {
  feishu: FeishuChannelSnapshot
  runtime: ChannelRuntimeStatus
}

export interface DesktopRuntimeDelta {
  runtime: ChannelRuntimeStatus
  /** 仅包含 main 侧高水位之后的新拒绝；首次调用只建基线，返回空数组。 */
  newDenials: ChannelDenialNotice[]
}

export interface DesktopFeishuRegistrationSnapshot extends FeishuRegistrationSnapshot {
  qrDataUrl?: string
}

export interface DesktopFeishuConnectInput {
  appId: string
  appSecret: string
  domain?: ChannelDomain
}

export interface DesktopFeishuPatchInput {
  enabled?: boolean
  sendProgress?: boolean
  sendToolHints?: boolean
}

export interface DesktopFeishuAllowInput {
  id: string
  name?: string
}

export interface DesktopFeishuRegistrationStartInput {
  domain?: ChannelDomain
}

/**
 * 会话是否属于 IM 渠道。主判据是 `externalConversation` 标记，兼容只有
 * `source === "channel"` 的旧数据；fork 出来的普通会话不算（fork 会复制源 metadata）。
 */
export function isChannelSessionMetadata(metadata: Record<string, unknown>): boolean {
  if (metadata.fork) return false
  const external = metadata.externalConversation
  return (
    (typeof external === "object" && external !== null && !Array.isArray(external)) ||
    metadata.source === "channel"
  )
}

/** 渠道平台显示名。服务端在 channel-connector-labels.ts 保留同一张表的副本。 */
const CHANNEL_CONNECTOR_LABELS: Record<string, string> = {
  feishu: "飞书",
  lark: "飞书（国际）",
}

export function channelConnectorLabel(connector: string | undefined): string {
  if (!connector) return "其他平台"
  return CHANNEL_CONNECTOR_LABELS[connector.trim().toLowerCase()] ?? "其他平台"
}
