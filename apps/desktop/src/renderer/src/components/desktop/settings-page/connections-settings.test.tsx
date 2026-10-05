// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopFeishuRegistrationSnapshot } from "@shared/channel-types"
import { ConnectionsSettings } from "./connections-settings"

const runningRuntime = {
  bootId: "boot-1",
  connectors: [{ connector: "feishu", enabled: true, state: "running" as const }],
  recentDenials: [],
}

const feishuSnapshot = {
  configured: true,
  enabled: true,
  appId: "cli_x",
  botName: "Harness Bot",
  allowFrom: [{ name: "me", id: "ou_me" }],
}

const unconfiguredSnapshot = { configured: false, enabled: false, allowFrom: [] }
const qrReady = {
  state: "qr_ready" as const,
  attempt: 1,
  domain: "feishu" as const,
  qrUrl: "https://open.feishu.cn/example-authorization",
  qrDataUrl: "data:image/png;base64,qr",
  remainingSeconds: 600,
}

async function clickButton(label: string): Promise<void> {
  const button =
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    Array.from(document.body.querySelectorAll('button, [role="menuitem"]')).find((item) => {
      const copy = item.cloneNode(true) as HTMLElement
      copy.querySelectorAll('[aria-hidden="true"], .invisible').forEach((node) => node.remove())
      return copy.textContent?.trim() === label
    })
  expect(button, `按钮 ${label}`).toBeTruthy()
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
}

async function fillInput(label: string, value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function installDesktop(overrides: Record<string, unknown> = {}) {
  const connections = {
    snapshot: vi.fn(async () => ({ feishu: feishuSnapshot, runtime: runningRuntime })),
    runtimeStatus: vi.fn(async () => ({ runtime: runningRuntime, newDenials: [] })),
    patch: vi.fn(async () => ({
      feishu: { ...feishuSnapshot, enabled: false },
      runtime: runningRuntime,
    })),
    connect: vi.fn(),
    remove: vi.fn(),
    allowAdd: vi.fn(async () => ({
      ...feishuSnapshot,
      allowFrom: [...feishuSnapshot.allowFrom, { name: "ou_new", id: "ou_new" }],
    })),
    allowRemove: vi.fn(async () => feishuSnapshot),
    startRegistration: vi.fn(),
    registrationStatus: vi.fn(),
    cancelRegistration: vi.fn(async () => ({ state: "cancelled", attempt: 1, domain: "feishu" })),
    startRuntime: vi.fn(),
    stopRuntime: vi.fn(),
    ...overrides,
  }
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { connections },
  })
  return connections
}

describe("ConnectionsSettings", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("shows the live status, toggles the channel and adds allowlist entries", async () => {
    const connections = installDesktop()
    await act(async () => {
      root.render(<ConnectionsSettings />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain("已连接")
    expect(container.textContent).toContain("Harness Bot")
    const logo = container.querySelector<HTMLImageElement>('img[data-channel-logo="feishu"]')
    expect(logo).toBeTruthy()
    expect(logo?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/)
    await clickButton("管理")
    expect(
      container.querySelector('[aria-expanded="true"][aria-controls="feishu-connection-details"]')
    ).toBeTruthy()
    const connectionInfo = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("连接信息")
    )
    expect(connectionInfo?.getAttribute("aria-expanded")).toBe("false")
    await clickButton("连接信息")
    expect(connectionInfo?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("cli_x")
    await clickButton("访问权限 · 1 个用户或群聊")

    const toggle = container.querySelector('[aria-label="启用飞书渠道"]')!
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(connections.patch).toHaveBeenCalledWith({ enabled: false })

    await clickButton("添加用户或群聊")

    const idInput = container.querySelector<HTMLInputElement>('[aria-label="白名单 ID"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(idInput, "ou_new")
      idInput.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("添加"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(connections.allowAdd).toHaveBeenCalledWith({ id: "ou_new" })
  })

  it("does not repeat an allowlist ID when it is also used as the display name", async () => {
    installDesktop({
      snapshot: vi.fn(async () => ({
        feishu: {
          ...feishuSnapshot,
          allowFrom: [{ name: "ou_same", id: "ou_same" }],
        },
        runtime: runningRuntime,
      })),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("管理")
    await clickButton("访问权限 · 1 个用户或群聊")

    const details = container.querySelector("#feishu-connection-details")!
    expect(details.textContent?.match(/ou_same/g)).toHaveLength(1)
  })

  it("surfaces denied senders with an add-to-allowlist action", async () => {
    vi.useFakeTimers()
    const denial = { connector: "feishu", sender: "ou_denied", chatId: "chat-1", at: 1, seq: 5 }
    const connections = installDesktop({
      runtimeStatus: vi.fn(async () => ({
        runtime: { ...runningRuntime, recentDenials: [denial] },
        newDenials: [denial],
      })),
    })
    await act(async () => {
      root.render(<ConnectionsSettings />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })

    expect(container.textContent).toContain("ou_denied")
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("加入白名单"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(connections.allowAdd).toHaveBeenCalledWith({ id: "ou_denied" })
  })

  it("starts QR authorization in a dialog and refreshes the saved channel after authorization", async () => {
    vi.useFakeTimers()
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ feishu: unconfiguredSnapshot, runtime: runningRuntime })
      .mockResolvedValue({ feishu: feishuSnapshot, runtime: runningRuntime })
    installDesktop({
      snapshot,
      startRegistration: vi.fn(async () => qrReady),
      registrationStatus: vi.fn(async () => ({ ...qrReady, state: "succeeded" })),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    expect(container.querySelector('input[aria-label="App Secret"]')).toBeNull()
    await clickButton("连接飞书")
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.querySelector('img[alt="飞书接入二维码"]')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(dialog.textContent).toContain("已连接")
    expect(container.textContent).toContain("Harness Bot")
    await clickButton("完成")
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[aria-label="启用飞书渠道"]')).toBeTruthy()
  })

  it("cancels QR authorization when switching to manual connection and clears secrets on failure", async () => {
    const connections = installDesktop({
      snapshot: vi.fn(async () => ({ feishu: unconfiguredSnapshot, runtime: runningRuntime })),
      startRegistration: vi.fn(async () => qrReady),
      connect: vi.fn(async () => {
        throw new Error("凭据校验失败")
      }),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await clickButton("使用已有应用手动连接")
    expect(connections.cancelRegistration).toHaveBeenCalledOnce()
    await fillInput("App ID", " cli_existing ")
    await fillInput("App Secret", " demo-secret ")
    await clickButton("验证并连接")
    expect(connections.connect).toHaveBeenCalledWith({
      appId: "cli_existing",
      appSecret: " demo-secret ",
      domain: "feishu",
    })
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="App Secret"]')?.value
    ).toBe("")
    expect(document.body.textContent).toContain("凭据校验失败")
  })

  it("stops polling after the connection dialog closes", async () => {
    vi.useFakeTimers()
    const connections = installDesktop({
      snapshot: vi.fn(async () => ({ feishu: unconfiguredSnapshot, runtime: runningRuntime })),
      startRegistration: vi.fn(async () => qrReady),
      registrationStatus: vi.fn(async () => qrReady),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await clickButton("关闭连接弹窗")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(connections.cancelRegistration).toHaveBeenCalledOnce()
    expect(connections.registrationStatus).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it("finishes cancelling a pending QR request before starting a reopened dialog", async () => {
    let resolveStart!: (value: typeof qrReady) => void
    const pending = new Promise<typeof qrReady>((resolve) => {
      resolveStart = resolve
    })
    const calls: string[] = []
    let starts = 0
    installDesktop({
      snapshot: vi.fn(async () => ({ feishu: unconfiguredSnapshot, runtime: runningRuntime })),
      startRegistration: vi.fn(async () => {
        calls.push("start")
        return starts++ === 0 ? pending : qrReady
      }),
      cancelRegistration: vi.fn(async () => {
        calls.push("cancel")
        return { ...qrReady, state: "cancelled" }
      }),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await clickButton("关闭连接弹窗")
    await clickButton("连接飞书")
    expect(calls).toEqual(["start"])
    await act(async () => {
      resolveStart(qrReady)
      await pending
    })
    expect(calls).toEqual(["start", "cancel", "start"])
    expect(document.body.querySelector('img[alt="飞书接入二维码"]')).toBeTruthy()
  })

  it("does not report an online connection when authorization saved credentials but the runtime failed", async () => {
    vi.useFakeTimers()
    const failedRuntime = {
      ...runningRuntime,
      connectors: [
        { connector: "feishu", enabled: true, state: "error", lastError: "网络连接中断" },
      ],
    }
    installDesktop({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce({ feishu: unconfiguredSnapshot, runtime: runningRuntime })
        .mockResolvedValue({ feishu: feishuSnapshot, runtime: failedRuntime }),
      startRegistration: vi.fn(async () => qrReady),
      registrationStatus: vi.fn(async () => ({ ...qrReady, state: "succeeded" })),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("机器人已创建")
    expect(dialog.textContent).toContain("网络连接中断")
    expect(dialog.textContent).not.toContain("飞书已连接")
  })

  it("regenerates expired QR authorization instead of using the expired link", async () => {
    vi.useFakeTimers()
    const connections = installDesktop({
      snapshot: vi.fn(async () => ({ feishu: unconfiguredSnapshot, runtime: runningRuntime })),
      startRegistration: vi
        .fn()
        .mockResolvedValueOnce(qrReady)
        .mockResolvedValue({ ...qrReady, attempt: 2, qrDataUrl: "data:image/png;base64,new-qr" }),
      registrationStatus: vi.fn(async () => ({
        ...qrReady,
        state: "expired",
        remainingSeconds: 0,
      })),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(document.body.textContent).toContain("二维码已过期")
    expect(document.body.querySelector('img[alt="飞书接入二维码"]')).toBeNull()
    await clickButton("重新生成")
    expect(document.body.querySelector('img[alt="飞书接入二维码"]')?.getAttribute("src")).toBe(
      "data:image/png;base64,new-qr"
    )
    expect(connections.startRegistration).toHaveBeenCalledTimes(2)
  })

  it("ignores a successful poll that resolves after the dialog was closed", async () => {
    vi.useFakeTimers()
    let resolvePoll!: (value: DesktopFeishuRegistrationSnapshot) => void
    const pending = new Promise<DesktopFeishuRegistrationSnapshot>((resolve) => {
      resolvePoll = resolve
    })
    installDesktop({
      snapshot: vi.fn(async () => ({ feishu: unconfiguredSnapshot, runtime: runningRuntime })),
      startRegistration: vi.fn(async () => qrReady),
      registrationStatus: vi.fn(() => pending),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    await clickButton("关闭连接弹窗")
    await act(async () => {
      resolvePoll({ ...qrReady, state: "succeeded" })
      await pending
    })
    expect(container.querySelector('[aria-label="连接飞书"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="启用飞书渠道"]')).toBeNull()
  })

  it("keeps a failed removal visible in the confirmation dialog", async () => {
    installDesktop({
      remove: vi.fn(async () => {
        throw new Error("删除配置失败")
      }),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("飞书更多操作")
    await clickButton("移除连接")
    await clickButton("移除连接")
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("删除配置失败")
    await clickButton("取消")
    expect(container.querySelector('[aria-label="启用飞书渠道"]')).toBeTruthy()
  })

  it("does not let cancellation from a previous settings page cancel a new page's scan", async () => {
    let resolveStart!: (value: typeof qrReady) => void
    const pending = new Promise<typeof qrReady>((resolve) => {
      resolveStart = resolve
    })
    const calls: string[] = []
    let starts = 0
    installDesktop({
      snapshot: vi.fn(async () => ({ feishu: unconfiguredSnapshot, runtime: runningRuntime })),
      startRegistration: vi.fn(async () => {
        calls.push("start")
        return starts++ === 0 ? pending : qrReady
      }),
      cancelRegistration: vi.fn(async () => {
        calls.push("cancel")
        return { ...qrReady, state: "cancelled" }
      }),
    })
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    await act(async () => root.render(null))
    await act(async () => root.render(<ConnectionsSettings />))
    await clickButton("连接飞书")
    expect(calls).toEqual(["start"])
    await act(async () => {
      resolveStart(qrReady)
      await pending
    })
    expect(calls).toEqual(["start", "cancel", "start"])
    expect(document.body.querySelector('img[alt="飞书接入二维码"]')).toBeTruthy()
  })
})
