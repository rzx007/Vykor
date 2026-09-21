import { describe, expect, it, vi } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"
import { DesktopSettingsService } from "./settings-service"

const defaultSnapshot = {
  workStyle: "practical",
  notificationMode: "when_unfocused",
  agentEnvironment: "native",
  showReasoning: true,
  wslSupported: false,
  restartRequired: false,
  defaultOpenerId: null,
  defaultTerminalShellId: null,
} as const

const preferences = () => ({
  notificationMode: "when_unfocused" as const,
})

describe("buildDesktopSettingsSnapshot", () => {
  it("defaults safely", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual(defaultSnapshot)
  })

  it("preserves an efficient work style", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "efficient" })).toEqual({
      ...defaultSnapshot,
      workStyle: "efficient",
    })
  })

  it("rejects unknown persisted values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "chatty" })).toEqual(defaultSnapshot)
  })

  it("preserves valid notification and desktop preference values", () => {
    expect(
      buildDesktopSettingsSnapshot(
        {},
        {
          notificationMode: "always",
          defaultOpenerId: "  vscode  ",
          defaultTerminalShellId: "  pwsh  ",
        }
      )
    ).toMatchObject({
      notificationMode: "always",
      defaultOpenerId: "vscode",
      defaultTerminalShellId: "pwsh",
    })
  })

  it("normalizes unknown or blank preference values", () => {
    expect(
      buildDesktopSettingsSnapshot(
        {},
        {
          notificationMode: "chatty",
          defaultOpenerId: "   ",
          defaultTerminalShellId: "system",
        }
      )
    ).toMatchObject({
      notificationMode: "when_unfocused",
      defaultOpenerId: null,
      defaultTerminalShellId: null,
    })
  })

  it("uses only the explicit agent environment setting", () => {
    expect(
      buildDesktopSettingsSnapshot({
        agentEnvironment: { kind: "wsl" },
      })
    ).toMatchObject({ agentEnvironment: "wsl" })
    expect(
      buildDesktopSettingsSnapshot({
        agentEnvironment: { kind: "unexpected" },
      })
    ).toMatchObject({ agentEnvironment: "native" })
  })
})

describe("DesktopSettingsService.updateAgentEnvironment", () => {
  it("lets the daemon validate WSL before saving the global environment", async () => {
    const patchSettings = vi.fn(async (patch) => {
      return patch
    })
    const capabilities = vi.fn(async () => ({
      serverVersion: "1",
      protocol: { version: 2 },
      features: {},
      agentEnvironments: { native: true as const, wsl: true },
    }))
    const service = new DesktopSettingsService({
      daemonClient: async () => ({
        protocol: { capabilities },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      refreshDaemonClient: async () => ({
        protocol: { capabilities },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    const result = await service.updateAgentEnvironment({ environment: "wsl" })

    expect(patchSettings).toHaveBeenCalledWith({
      agentEnvironment: { kind: "wsl" },
    })
    expect(result).toMatchObject({
      agentEnvironment: "wsl",
      restartRequired: true,
      wslSupported: true,
    })
  })

  it("surfaces a daemon-side WSL validation failure", async () => {
    const patchSettings = vi.fn(async () => {
      throw new Error("WSL is not installed on the daemon host")
    })
    const capabilities = vi.fn()
    const service = new DesktopSettingsService({
      daemonClient: async () => ({
        protocol: { capabilities },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      refreshDaemonClient: async () => ({
        protocol: { capabilities },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    await expect(service.updateAgentEnvironment({ environment: "wsl" })).rejects.toThrow(
      "WSL is not installed on the daemon host"
    )
    expect(patchSettings).toHaveBeenCalledOnce()
    expect(capabilities).not.toHaveBeenCalled()
  })
})

describe("DesktopSettingsService.updateReasoningVisibility", () => {
  it("patches showReasoning through the daemon client", async () => {
    const patchSettings = vi.fn(async (patch) => patch)
    const service = new DesktopSettingsService({
      daemonClient: async () => ({
        protocol: { capabilities: vi.fn() },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      refreshDaemonClient: async () => ({
        protocol: { capabilities: vi.fn() },
        system: { getSettings: vi.fn(), patchSettings },
      }),
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    const result = await service.updateReasoningVisibility({ showReasoning: false })

    expect(patchSettings).toHaveBeenCalledWith({ showReasoning: false })
    expect(result).toMatchObject({ showReasoning: false })
  })
})
