import { describe, expect, it, vi } from "vitest"
import type { DaemonAutoStartSnapshot } from "@vykor/server/daemon-host"

vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => "D:/app", getPath: () => "D:/data" },
}))

import { DaemonAutoStartService } from "./daemon-autostart-service"

function fixture(
  options: { configured?: boolean; state?: "not-installed" | "stopped" | "running" } = {}
) {
  let host: DaemonAutoStartSnapshot = {
    configured: options.configured ?? false,
    serviceState: options.state ?? "not-installed",
    enabled: (options.configured ?? false) && options.state !== "not-installed",
  }
  let preferences: {
    notificationMode: "when_unfocused"
    installIdentity: "new"
    daemonOnboardingState: "pending" | "enabled" | "dismissed"
  } = {
    notificationMode: "when_unfocused" as const,
    installIdentity: "new" as const,
    daemonOnboardingState: "pending",
  }
  const enable = vi.fn(async () => {
    host = { configured: true, serviceState: "running", enabled: true }
    return host
  })
  const disable = vi.fn(async () => {
    host = { configured: false, serviceState: "not-installed", enabled: false }
    return host
  })
  const service = new DaemonAutoStartService({
    preferences: vi.fn(() => preferences),
    initializeIdentity: vi.fn(() => preferences),
    patchPreferences: vi.fn((patch) => {
      preferences = { ...preferences, ...patch }
      return preferences
    }),
    controller: () => ({ snapshot: async () => host, enable, disable }),
  })
  return {
    service,
    enable,
    disable,
    preferences: () => preferences,
  }
}

describe("DaemonAutoStartService", () => {
  it("shows onboarding only for a pending new install with autostart disabled", async () => {
    const { service } = fixture()
    expect(await service.snapshot()).toMatchObject({ enabled: false, showOnboarding: true })
  })

  it("installs the service and completes onboarding", async () => {
    const { service, enable, preferences } = fixture()
    expect(await service.enable()).toMatchObject({ enabled: true, showOnboarding: false })
    expect(enable).toHaveBeenCalledOnce()
    expect(preferences().daemonOnboardingState).toBe("enabled")
  })

  it("uninstalls without resetting completed onboarding", async () => {
    const value = fixture({ configured: true, state: "running" })
    await value.service.enable()
    await value.service.disable()
    expect(value.disable).toHaveBeenCalledOnce()
    expect(value.preferences().daemonOnboardingState).toBe("enabled")
  })

  it("dismisses onboarding permanently", async () => {
    const { service, preferences } = fixture()
    expect(await service.dismissOnboarding()).toMatchObject({ showOnboarding: false })
    expect(preferences().daemonOnboardingState).toBe("dismissed")
  })
})
