import type {
  ChannelDenialNotice,
  ChannelRuntimeStatus,
  FeishuChannelSnapshot,
  FeishuRegistrationSnapshot,
} from "@openharness/client"

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
