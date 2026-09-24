import { dirname } from "node:path"

import {
  createDaemonAutoStartController,
  DaemonSystemService,
  type DaemonAutoStartController,
} from "@vykor/server/daemon-host"
import { app } from "electron"

import type { DesktopDaemonAutoStartSnapshot } from "../../../shared/settings-types"
import {
  getDesktopPreferences,
  initializeDesktopInstallIdentity,
  patchDesktopPreferences,
} from "../settings/desktop-preferences"

export interface DaemonAutoStartDependencies {
  preferences: typeof getDesktopPreferences
  initializeIdentity: typeof initializeDesktopInstallIdentity
  patchPreferences: typeof patchDesktopPreferences
  controller: () => DaemonAutoStartController
}

const defaultDependencies: DaemonAutoStartDependencies = {
  preferences: getDesktopPreferences,
  initializeIdentity: initializeDesktopInstallIdentity,
  patchPreferences: patchDesktopPreferences,
  controller: createDesktopDaemonAutoStartController,
}

export class DaemonAutoStartService {
  constructor(private readonly dependencies: DaemonAutoStartDependencies = defaultDependencies) {}

  async snapshot(): Promise<DesktopDaemonAutoStartSnapshot> {
    const preferences = this.dependencies.initializeIdentity()
    const host = await this.dependencies.controller().snapshot()
    const onboardingState = preferences.daemonOnboardingState ?? "dismissed"
    if (host.configured && onboardingState === "pending") {
      this.dependencies.patchPreferences({ daemonOnboardingState: "enabled" })
      return {
        ...host,
        onboardingState: "enabled",
        showOnboarding: false,
      }
    }
    return {
      ...host,
      onboardingState,
      showOnboarding: onboardingState === "pending" && !host.configured,
    }
  }

  async enable(): Promise<DesktopDaemonAutoStartSnapshot> {
    await this.dependencies.controller().enable()
    this.dependencies.patchPreferences({ daemonOnboardingState: "enabled" })
    return await this.snapshot()
  }

  async disable(): Promise<DesktopDaemonAutoStartSnapshot> {
    await this.dependencies.controller().disable()
    return await this.snapshot()
  }

  async dismissOnboarding(): Promise<DesktopDaemonAutoStartSnapshot> {
    const preferences = this.dependencies.preferences()
    if (preferences.daemonOnboardingState === "pending") {
      this.dependencies.patchPreferences({ daemonOnboardingState: "dismissed" })
    }
    return await this.snapshot()
  }
}

export function createDesktopDaemonSystemService(): DaemonSystemService {
  const flag = process.platform === "win32" ? "--daemon-watchdog" : "--daemon-service"
  const args = app.isPackaged ? [flag] : [app.getAppPath(), flag]
  return new DaemonSystemService({
    invocation: { command: process.execPath, args, cwd: dirname(process.execPath) },
  })
}

export function createDesktopDaemonAutoStartController(): DaemonAutoStartController {
  return createDaemonAutoStartController({
    invocation: createDesktopDaemonSystemService().invocation(),
  })
}

export const daemonAutoStartService = new DaemonAutoStartService()
