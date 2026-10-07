// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopPermissionSettingsSnapshot } from "@shared/permission-settings-types"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: {
    getState: () => ({ refreshBootstrap: async () => {}, sessions: [] }),
  },
}))
import { PermissionSettings } from "./permission-settings"

const saved: DesktopPermissionSettingsSnapshot = {
  permission: { mode: "default", deniedTools: ["Write"] },
  environment: "native",
  sandbox: {
    enabled: false,
    failIfUnavailable: false,
    enabledPlatforms: ["linux", "macos"],
    filesystem: {
      allowRead: ["."],
      allowWrite: ["."],
      denyRead: ["/private"],
      denyWrite: ["/protected"],
      extraAllowedRoots: ["/shared"],
    },
    network: {
      mode: "proxy",
      allowedDomains: ["example.com"],
      deniedDomains: ["blocked.example.com"],
      strictDomainPolicy: true,
    },
    srt: { runtimeCommand: "custom-srt" },
  },
  isolationAvailable: true,
  isolationReason: null,
  browserDeveloperMode: false,
  toolApprovals: [],
  browserApprovals: [],
}

describe("PermissionSettings", () => {
  let container: HTMLDivElement, root: Root
  const update = vi.fn(async () => saved)
  const read = vi.fn(async () => saved)
  const updateIsolation = vi.fn(async (input: { sandbox: typeof saved.sandbox }) => ({
    ...saved,
    sandbox: input.sandbox,
  }))
  const updateBrowserDeveloperMode = vi.fn(async () => ({ browserDeveloperMode: true }))
  const revoke = vi.fn(async () => saved)
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    update.mockReset().mockResolvedValue(saved)
    read.mockReset().mockResolvedValue(saved)
    updateIsolation.mockReset().mockImplementation(async (input) => ({
      ...saved,
      sandbox: input.sandbox,
    }))
    updateBrowserDeveloperMode.mockClear()
    revoke.mockReset().mockResolvedValue(saved)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        permissionSettings: { snapshot: read, update, updateIsolation, revoke },
        settings: { updateBrowserDeveloperMode },
      },
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  async function clickButton(text: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === text
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  function protectionSwitch() {
    const control = container.querySelector<HTMLInputElement>("#permission-protection")
    expect(control).not.toBeNull()
    return control!
  }

  it("confirms enabling protection and preserves existing access rules", async () => {
    await act(async () => root.render(<PermissionSettings />))
    await act(async () => protectionSwitch().click())
    expect(updateIsolation).not.toHaveBeenCalled()
    expect(protectionSwitch().checked).toBe(false)
    await clickButton("开启保护")
    expect(updateIsolation).toHaveBeenCalledWith({
      sandbox: { ...saved.sandbox, enabled: true, failIfUnavailable: true },
      expectedSandbox: saved.sandbox,
    })
    expect(protectionSwitch().checked).toBe(true)
  })
  it("allows disabling a saved protection setting even when unavailable", async () => {
    const current = {
      ...saved,
      sandbox: { ...saved.sandbox, enabled: true, failIfUnavailable: true },
      isolationAvailable: false,
      isolationReason: "平台不支持",
    }
    read.mockResolvedValue(current)
    await act(async () => root.render(<PermissionSettings />))
    expect(protectionSwitch().disabled).toBe(false)
    await act(async () => protectionSwitch().click())
    expect(updateIsolation).not.toHaveBeenCalled()
    await clickButton("关闭保护")
    expect(updateIsolation).toHaveBeenCalledWith({
      sandbox: { ...current.sandbox, enabled: false },
      expectedSandbox: current.sandbox,
    })
    expect(protectionSwitch().checked).toBe(false)
  })
  it("does not offer to enable protection in an unsupported environment", async () => {
    read.mockResolvedValue({
      ...saved,
      isolationAvailable: false,
      isolationReason: "平台不支持",
    })
    await act(async () => root.render(<PermissionSettings />))
    expect(protectionSwitch().disabled).toBe(true)
    expect(protectionSwitch().checked).toBe(false)
  })
  it("keeps the saved protection state and shows failures", async () => {
    updateIsolation.mockRejectedValueOnce(new Error("访问规则已被其他窗口修改"))
    await act(async () => root.render(<PermissionSettings />))
    await act(async () => protectionSwitch().click())
    await clickButton("开启保护")
    expect(protectionSwitch().checked).toBe(false)
    expect(container.textContent).toContain("访问规则已被其他窗口修改")
  })
  it("changes browser diagnostics without writing unrelated permission rules", async () => {
    await act(async () => root.render(<PermissionSettings />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#browser-developer-mode")!.click()
    )
    expect(updateBrowserDeveloperMode).toHaveBeenCalledWith({ enabled: true })
    expect(container.querySelector<HTMLInputElement>("#browser-developer-mode")!.checked).toBe(true)
    expect(update).not.toHaveBeenCalled()
    expect(updateIsolation).not.toHaveBeenCalled()
  })
  it("opens saved grants on demand and confirms before revoking", async () => {
    read.mockResolvedValue({
      ...saved,
      toolApprovals: [{ id: "grant-1", sessionId: "session-1", toolName: "Shell", updatedAt: 1 }],
    })
    await act(async () => root.render(<PermissionSettings />))
    expect(container.textContent).not.toContain("Shell")
    await clickButton("管理授权")
    const revokeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="撤销 Shell 授权"]'
    )
    expect(revokeButton).not.toBeNull()
    await act(async () => revokeButton!.click())
    expect(revoke).not.toHaveBeenCalled()
    await clickButton("确认撤销")
    expect(revoke).toHaveBeenCalledWith({ kind: "tool", id: "grant-1" })
    expect(document.querySelector('button[aria-label="撤销 Shell 授权"]')).toBeNull()
  })
  it("shows a read failure without inventing editable defaults", async () => {
    read.mockRejectedValueOnce(new Error("后台服务未连接"))
    await act(async () => root.render(<PermissionSettings />))
    expect(container.textContent).toContain("后台服务未连接")
    expect(container.querySelector("#general-permission-mode")).toBeNull()
    expect(container.querySelector("#permission-protection")).toBeNull()
  })
})
