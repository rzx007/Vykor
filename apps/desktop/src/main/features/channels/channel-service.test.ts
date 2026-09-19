import { describe, expect, it, vi } from "vitest"

import type { ChannelRuntimeStatus } from "@openharness/client"

import { DesktopChannelService, type DesktopChannelClient } from "./channel-service"

const runtime = (over: Partial<ChannelRuntimeStatus> = {}): ChannelRuntimeStatus => ({
  bootId: "boot-1",
  connectors: [{ connector: "feishu", enabled: true, state: "running" }],
  recentDenials: [],
  ...over,
})

const denial = {
  connector: "feishu",
  sender: "ou_x",
  chatId: "chat-1",
  at: 1,
  seq: 1,
}

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const channels = {
    runtimeStatus: vi.fn(async () => runtime({ recentDenials: [denial] })),
    startRuntime: vi.fn(async () => runtime()),
    stopRuntime: vi.fn(async () => runtime()),
    getFeishu: vi.fn(async () => ({
      configured: true,
      enabled: true,
      appId: "cli_x",
      allowFrom: [],
    })),
    patchFeishu: vi.fn(async () => ({
      feishu: { configured: true, enabled: false, allowFrom: [] },
      runtime: runtime(),
    })),
    connectFeishu: vi.fn(async () => ({
      feishu: { configured: true, enabled: true, appId: "cli_x", allowFrom: [] },
      runtime: runtime(),
    })),
    removeFeishu: vi.fn(async () => ({
      feishu: { configured: false, enabled: false, allowFrom: [] },
      runtime: runtime(),
    })),
    addFeishuAllow: vi.fn(async () => ({
      configured: true,
      enabled: true,
      allowFrom: [{ name: "Alice", id: "ou_1" }],
    })),
    removeFeishuAllow: vi.fn(async () => ({
      configured: true,
      enabled: true,
      allowFrom: [],
    })),
    startFeishuRegistration: vi.fn(async () => ({
      state: "qr_ready",
      attempt: 1,
      domain: "feishu",
      qrUrl: "https://open.feishu.cn/x",
    })),
    feishuRegistrationStatus: vi.fn(async () => ({
      state: "idle",
      attempt: 1,
      domain: "feishu",
    })),
    cancelFeishuRegistration: vi.fn(async () => ({
      state: "cancelled",
      attempt: 1,
      domain: "feishu",
    })),
    ...overrides,
  }
  return { channels } as unknown as DesktopChannelClient
}

function makeService(client: DesktopChannelClient, qr?: (url: string) => Promise<string>) {
  return new DesktopChannelService({
    getClient: async () => client,
    ...(qr ? { generateQrDataUrl: qr } : {}),
  })
}

describe("DesktopChannelService", () => {
  it("composes the snapshot and only reports denials above the high-water mark", async () => {
    const service = makeService(makeClient())
    await service.snapshot()
    const first = await service.runtimeStatus()
    expect(first.newDenials).toEqual([denial])
    const second = await service.runtimeStatus()
    expect(second.newDenials).toEqual([])
  })

  it("rebuilds the denial baseline when the daemon bootId changes", async () => {
    let bootId = "boot-1"
    const client = makeClient({
      runtimeStatus: vi.fn(async () => runtime({ bootId, recentDenials: [denial] })),
    })
    const service = makeService(client)
    await service.snapshot()
    expect((await service.runtimeStatus()).newDenials).toEqual([denial]);
    bootId = "boot-2"
    expect((await service.runtimeStatus()).newDenials).toEqual([])
    expect((await service.runtimeStatus()).newDenials).toEqual([denial])
  })

  it("attaches a generated QR data URL without leaking the secret", async () => {
    const client = makeClient()
    const service = makeService(client, async () => "data:image/png;base64,AAAA")
    const snapshot = await service.startRegistration({ domain: "feishu" })
    expect(snapshot).toMatchObject({
      state: "qr_ready",
      qrUrl: "https://open.feishu.cn/x",
      qrDataUrl: "data:image/png;base64,AAAA",
    })
    expect(JSON.stringify(snapshot)).not.toContain("appSecret")
  })

  it("still returns the snapshot when QR generation fails", async () => {
    const service = makeService(makeClient(), async () => {
      throw new Error("qr boom")
    })
    const snapshot = await service.startRegistration()
    expect(snapshot).toMatchObject({ state: "qr_ready", qrUrl: "https://open.feishu.cn/x" })
    expect(snapshot.qrDataUrl).toBeUndefined()
  })

  it("delegates connect, patch, allow and runtime control", async () => {
    const client = makeClient()
    const service = makeService(client)
    await service.connect({ appId: "cli_x", appSecret: "sec" })
    await service.patch({ enabled: false })
    await service.allowAdd({ id: "ou_1", name: "Alice" })
    await service.allowRemove("Alice")
    await service.startRuntime()
    await service.stopRuntime()
    expect(client.channels.connectFeishu).toHaveBeenCalledWith({
      appId: "cli_x",
      appSecret: "sec",
    })
    expect(client.channels.patchFeishu).toHaveBeenCalledWith({ enabled: false })
    expect(client.channels.addFeishuAllow).toHaveBeenCalledWith({ id: "ou_1", name: "Alice" })
    expect(client.channels.removeFeishuAllow).toHaveBeenCalledWith("Alice")
    expect(client.channels.startRuntime).toHaveBeenCalledOnce()
    expect(client.channels.stopRuntime).toHaveBeenCalledOnce()
  })
})
