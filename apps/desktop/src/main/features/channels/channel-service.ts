import type {
  ChannelDenialNotice,
  ChannelRuntimeStatus,
  FeishuChannelSnapshot,
  FeishuRegistrationSnapshot,
} from "@openharness/client"

import type {
  DesktopConnectionsSnapshot,
  DesktopFeishuAllowInput,
  DesktopFeishuConnectInput,
  DesktopFeishuPatchInput,
  DesktopFeishuRegistrationSnapshot,
  DesktopFeishuRegistrationStartInput,
  DesktopRuntimeDelta,
} from "../../../shared/channel-types"
import { desktopSessionService } from "../session/session-service"

export interface DesktopChannelClient {
  channels: {
    runtimeStatus(): Promise<ChannelRuntimeStatus>
    startRuntime(input?: { connector?: string }): Promise<ChannelRuntimeStatus>
    stopRuntime(input?: { connector?: string }): Promise<ChannelRuntimeStatus>
    getFeishu(): Promise<FeishuChannelSnapshot>
    patchFeishu(
      input: DesktopFeishuPatchInput
    ): Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
    connectFeishu(
      input: DesktopFeishuConnectInput
    ): Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
    removeFeishu(): Promise<{
      feishu: FeishuChannelSnapshot
      runtime: ChannelRuntimeStatus
    }>
    addFeishuAllow(input: DesktopFeishuAllowInput): Promise<FeishuChannelSnapshot>
    removeFeishuAllow(key: string): Promise<FeishuChannelSnapshot>
    startFeishuRegistration(
      input?: DesktopFeishuRegistrationStartInput
    ): Promise<FeishuRegistrationSnapshot>
    feishuRegistrationStatus(): Promise<FeishuRegistrationSnapshot>
    cancelFeishuRegistration(): Promise<FeishuRegistrationSnapshot>
  }
}

export interface DesktopChannelServiceOptions {
  getClient(): Promise<DesktopChannelClient>
  /** 生成二维码图片；默认用 qrcode 包。测试可注入假实现。 */
  generateQrDataUrl?(url: string): Promise<string>
}

/**
 * Desktop 主进程的渠道接入服务：只经 daemon HTTP 读写，永不落盘密钥。
 * 持有 per-connector 拒绝高水位，页面重挂载不会重放旧提示。
 */
export class DesktopChannelService {
  private bootId: string | undefined
  private highWater = -1
  private qrCache: { key: string; dataUrl: string } | undefined

  constructor(private readonly options: DesktopChannelServiceOptions) {}

  async snapshot(): Promise<DesktopConnectionsSnapshot> {
    const client = await this.options.getClient()
    const [feishu, runtime] = await Promise.all([
      client.channels.getFeishu(),
      client.channels.runtimeStatus(),
    ])
    // 只建基线，不消费：挂载/刷新不能吞掉待提示的拒绝。
    this.baseline(runtime)
    return { feishu, runtime }
  }

  async runtimeStatus(): Promise<DesktopRuntimeDelta> {
    const client = await this.options.getClient()
    const runtime = await client.channels.runtimeStatus()
    return { runtime, newDenials: this.consumeDenials(runtime) }
  }

  async connect(input: DesktopFeishuConnectInput) {
    return await (await this.options.getClient()).channels.connectFeishu(input)
  }

  async patch(input: DesktopFeishuPatchInput) {
    return await (await this.options.getClient()).channels.patchFeishu(input)
  }

  async remove() {
    return await (await this.options.getClient()).channels.removeFeishu()
  }

  async allowAdd(input: DesktopFeishuAllowInput) {
    return await (await this.options.getClient()).channels.addFeishuAllow(input)
  }

  async allowRemove(key: string) {
    return await (await this.options.getClient()).channels.removeFeishuAllow(key)
  }

  async startRuntime() {
    return await (await this.options.getClient()).channels.startRuntime()
  }

  async stopRuntime() {
    return await (await this.options.getClient()).channels.stopRuntime()
  }

  async startRegistration(
    input: DesktopFeishuRegistrationStartInput = {}
  ): Promise<DesktopFeishuRegistrationSnapshot> {
    const client = await this.options.getClient()
    return await this.withQrDataUrl(await client.channels.startFeishuRegistration(input))
  }

  async registrationStatus(): Promise<DesktopFeishuRegistrationSnapshot> {
    const client = await this.options.getClient()
    return await this.withQrDataUrl(await client.channels.feishuRegistrationStatus())
  }

  async cancelRegistration(): Promise<DesktopFeishuRegistrationSnapshot> {
    const client = await this.options.getClient()
    return await this.withQrDataUrl(await client.channels.cancelFeishuRegistration())
  }

  private baseline(runtime: ChannelRuntimeStatus): void {
    if (runtime.bootId === this.bootId) return
    this.bootId = runtime.bootId
    this.highWater = maxDenialSeq(runtime)
  }

  private consumeDenials(runtime: ChannelRuntimeStatus): ChannelDenialNotice[] {
    if (runtime.bootId !== this.bootId) {
      this.bootId = runtime.bootId
      this.highWater = maxDenialSeq(runtime)
      return []
    }
    const fresh = runtime.recentDenials.filter((denial) => denial.seq > this.highWater)
    if (fresh.length > 0) {
      this.highWater = Math.max(this.highWater, ...fresh.map((denial) => denial.seq))
    }
    return fresh
  }

  private async withQrDataUrl(
    snapshot: FeishuRegistrationSnapshot
  ): Promise<DesktopFeishuRegistrationSnapshot> {
    if (!snapshot.qrUrl) return snapshot
    const key = `${snapshot.attempt}|${snapshot.qrUrl}`
    if (this.qrCache?.key === key) {
      return { ...snapshot, qrDataUrl: this.qrCache.dataUrl }
    }
    try {
      const generate = this.options.generateQrDataUrl ?? defaultGenerateQrDataUrl
      const qrDataUrl = await generate(snapshot.qrUrl)
      this.qrCache = { key, dataUrl: qrDataUrl }
      return { ...snapshot, qrDataUrl }
    } catch {
      // 生成失败时不带 data URL 返回，客户端可退回展示授权链接。
      return snapshot
    }
  }
}

function maxDenialSeq(runtime: ChannelRuntimeStatus): number {
  return runtime.recentDenials.reduce((max, denial) => Math.max(max, denial.seq), -1)
}

async function defaultGenerateQrDataUrl(url: string): Promise<string> {
  const imported = (await import("qrcode")) as unknown as {
    toDataURL?: (text: string, options?: unknown) => Promise<string>
    default?: { toDataURL?: (text: string, options?: unknown) => Promise<string> }
  }
  const qr = imported.default ?? imported
  if (!qr.toDataURL) throw new Error("qrcode is unavailable")
  return await qr.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
  })
}

export const desktopChannelService = new DesktopChannelService({
  getClient: () => desktopSessionService.daemonClient(),
})
