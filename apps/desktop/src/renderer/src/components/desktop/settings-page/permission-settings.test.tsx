// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopPermissionSettingsSnapshot } from "@shared/permission-settings-types"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: { getState: () => ({ refreshBootstrap: async () => {} }) },
}))
import { PermissionSettings } from "./permission-settings"

const saved: DesktopPermissionSettingsSnapshot = {
  permission: { mode: "default", deniedTools: ["Write"] },
  environment: "native",
  sandbox: {
    enabled: false,
    failIfUnavailable: false,
    enabledPlatforms: [],
    filesystem: {
      allowRead: ["."],
      allowWrite: ["."],
      denyRead: [],
      denyWrite: [],
      extraAllowedRoots: [],
    },
    network: { mode: "none", allowedDomains: [], deniedDomains: [], strictDomainPolicy: false },
    srt: { runtimeCommand: "srt" },
  },
  isolationAvailable: false,
  isolationReason: "平台不支持",
  browserDeveloperMode: false,
  toolApprovals: [],
  browserApprovals: [],
}

describe("PermissionSettings", () => {
  let container: HTMLDivElement, root: Root
  const update = vi.fn(async () => saved)
  const read = vi.fn(async () => saved)
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    update.mockReset().mockResolvedValue(saved)
    read.mockReset().mockResolvedValue(saved)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        permissionSettings: { snapshot: read, update },
        settings: { updateBrowserDeveloperMode: async () => ({ browserDeveloperMode: true }) },
      },
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  async function editRules() {
    const input = container.querySelector<HTMLTextAreaElement>("#permissions-deniedTools")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Shell"
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    return input
  }
  it("preserves a failed save as a draft and shows the actual error", async () => {
    update.mockRejectedValueOnce(new Error("保存失败"))
    await act(async () => root.render(<PermissionSettings />))
    const input = await editRules()
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "保存权限设置")!
        .click()
    )
    expect(input.value).toBe("Shell")
    expect(container.textContent).toContain("保存失败")
    expect(update).toHaveBeenCalledWith({
      permission: { mode: "default", deniedTools: ["Shell"] },
      expectedPermission: saved.permission,
    })
  })
  it("does not discard a rule draft when the browser preference changes", async () => {
    await act(async () => root.render(<PermissionSettings />))
    await editRules()
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#browser-developer-mode")!.click()
    )
    expect(container.querySelector<HTMLTextAreaElement>("#permissions-deniedTools")!.value).toBe(
      "Shell"
    )
    expect(container.querySelector<HTMLInputElement>("#browser-developer-mode")!.checked).toBe(true)
  })
  it("shows a read failure without inventing editable defaults", async () => {
    read.mockRejectedValueOnce(new Error("后台服务未连接"))
    await act(async () => root.render(<PermissionSettings />))
    expect(container.textContent).toContain("后台服务未连接")
    expect(container.querySelector("#permission-mode")).toBeNull()
  })
})
