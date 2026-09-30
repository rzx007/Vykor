import { describe, expect, it, vi } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"
import { browserAgentService } from "../browser/browser-agent-service"
import { DesktopSettingsService } from "./settings-service"

const defaultSnapshot = {
  workStyle: "practical",
  notificationMode: "when_unfocused",
  agentEnvironment: "native",
  showReasoning: true,
  browserDeveloperMode: false,
  wslSupported: false,
  restartRequired: false,
  defaultOpenerId: null,
  defaultTerminalShellId: null,
  customInstructions: "",
  memoryEnabled: true,
  autoExtractEnabled: true,
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

  it("defaults browser developer mode to off", () => {
    expect(buildDesktopSettingsSnapshot({}).browserDeveloperMode).toBe(false)
    expect(
      buildDesktopSettingsSnapshot({}, { browserDeveloperMode: "yes" as never })
        .browserDeveloperMode
    ).toBe(false)
  })

  it("reads only an explicit true browser developer mode flag", () => {
    expect(
      buildDesktopSettingsSnapshot({}, { browserDeveloperMode: true }).browserDeveloperMode
    ).toBe(true)
  })

  it("reads custom instructions and semantic memory switches from daemon settings", () => {
    expect(
      buildDesktopSettingsSnapshot({
        systemPrompt: "请先说结论",
        memory: { enabled: false, autoExtractEnabled: false },
      })
    ).toMatchObject({
      customInstructions: "请先说结论",
      memoryEnabled: false,
      autoExtractEnabled: false,
    })
  })
})

describe("DesktopSettingsService personalization", () => {
  const createService = () => {
    const patchSettings = vi.fn(async (patch: Record<string, unknown>) => patch)
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
    return { service, patchSettings }
  }

  it("saves custom instructions as the daemon systemPrompt", async () => {
    const { service, patchSettings } = createService()
    await service.updateCustomInstructions({ content: "先给结论" })
    expect(patchSettings).toHaveBeenCalledWith({ systemPrompt: "先给结论" })
  })

  it("patches one memory setting without clearing the other", async () => {
    const { service, patchSettings } = createService()
    await service.updateMemorySettings({ enabled: false })
    expect(patchSettings).toHaveBeenCalledWith({ memory: { enabled: false } })
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

describe("DesktopSettingsService.updateBrowserDeveloperMode", () => {
  function serviceWith(patchPreferences: ReturnType<typeof vi.fn>): DesktopSettingsService {
    const capabilities = vi.fn(async () => ({
      serverVersion: "1",
      protocol: { version: 2 },
      features: {},
    }))
    return new DesktopSettingsService({
      daemonClient: async () => ({
        protocol: { capabilities },
        system: { getSettings: vi.fn(async () => ({})), patchSettings: vi.fn() },
      }),
      refreshDaemonClient: async () => ({
        protocol: { capabilities },
        system: { getSettings: vi.fn(async () => ({})), patchSettings: vi.fn() },
      }),
      getPreferences: preferences,
      patchPreferences: patchPreferences as never,
    })
  }

  it("rejects a non-boolean developer mode before persisting", async () => {
    const patchPreferences = vi.fn()
    const service = serviceWith(patchPreferences)

    await expect(service.updateBrowserDeveloperMode({ enabled: "true" as never })).rejects.toThrow(
      "Developer mode must be a boolean."
    )
    expect(patchPreferences).not.toHaveBeenCalled()
  })

  it("persists the boolean and reflects it in the returned snapshot", async () => {
    const patchPreferences = vi.fn((patch: { browserDeveloperMode?: boolean }) => ({
      notificationMode: "when_unfocused" as const,
      ...patch,
    }))
    const service = serviceWith(patchPreferences)

    const result = await service.updateBrowserDeveloperMode({ enabled: true })

    expect(patchPreferences).toHaveBeenCalledWith({ browserDeveloperMode: true })
    expect(result.browserDeveloperMode).toBe(true)
  })

  it("stops an active capture immediately when developer mode is disabled", async () => {
    const patchPreferences = vi.fn((patch: { browserDeveloperMode?: boolean }) => ({
      notificationMode: "when_unfocused" as const,
      ...patch,
    }))
    const service = serviceWith(patchPreferences)
    const stop = vi.spyOn(browserAgentService, "stopDeveloperDiagnostics").mockReturnValue(true)

    try {
      await service.updateBrowserDeveloperMode({ enabled: false })
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      stop.mockRestore()
    }
  })

  it("keeps an active capture when developer mode is enabled", async () => {
    const patchPreferences = vi.fn((patch: { browserDeveloperMode?: boolean }) => ({
      notificationMode: "when_unfocused" as const,
      ...patch,
    }))
    const service = serviceWith(patchPreferences)
    const stop = vi.spyOn(browserAgentService, "stopDeveloperDiagnostics").mockReturnValue(true)

    try {
      await service.updateBrowserDeveloperMode({ enabled: true })
      expect(stop).not.toHaveBeenCalled()
    } finally {
      stop.mockRestore()
    }
  })
})
