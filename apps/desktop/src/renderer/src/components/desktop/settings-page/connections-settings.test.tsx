// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    allowAdd: vi.fn(async () => ({ ...feishuSnapshot, allowFrom: [...feishuSnapshot.allowFrom, { name: "ou_new", id: "ou_new" }] })),
    allowRemove: vi.fn(async () => feishuSnapshot),
    startRegistration: vi.fn(),
    registrationStatus: vi.fn(),
    cancelRegistration: vi.fn(),
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
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("shows the live status, toggles the channel and adds allowlist entries", async () => {
    const connections = installDesktop()
    await act(async () => {
      root.render(<ConnectionsSettings />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain("在线")
    expect(container.textContent).toContain("cli_x")
    expect(container.textContent).toContain("Harness Bot")

    const toggle = container.querySelector('[aria-label="启用飞书渠道"]')!
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(connections.patch).toHaveBeenCalledWith({ enabled: false })

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
})
