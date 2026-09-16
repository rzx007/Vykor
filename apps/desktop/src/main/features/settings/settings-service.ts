import type { ProtocolClient, SystemResource } from "@openharness/client"

import {
  buildDesktopSettingsSnapshot,
  isDesktopNotificationMode,
  isDesktopWorkStyle,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
} from "../../../shared/settings-types"
import type {
  DesktopSettingsSnapshot,
  UpdateDesktopAgentEnvironmentInput,
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import { desktopSessionService } from "../session/session-service"
import {
  getDesktopPreferences,
  patchDesktopPreferences,
  type DesktopPreferences,
} from "./desktop-preferences"

interface SettingsClient {
  protocol: Pick<ProtocolClient, "capabilities">
  system: Pick<SystemResource, "getSettings" | "patchSettings">
}

export interface DesktopSettingsServiceDependencies {
  daemonClient(): Promise<SettingsClient>
  refreshDaemonClient(): Promise<SettingsClient>
  getPreferences: typeof getDesktopPreferences
  patchPreferences: typeof patchDesktopPreferences
}

const defaultDependencies: DesktopSettingsServiceDependencies = {
  daemonClient: () => desktopSessionService.daemonClient(),
  refreshDaemonClient: () => desktopSessionService.refreshDaemonClient(),
  getPreferences: getDesktopPreferences,
  patchPreferences: patchDesktopPreferences,
}

export class DesktopSettingsService {
  constructor(
    private readonly dependencies: DesktopSettingsServiceDependencies = defaultDependencies
  ) {}

  snapshot(): Promise<DesktopSettingsSnapshot> {
    return this.snapshotWithPreferences(this.dependencies.getPreferences())
  }

  async updateWorkStyle(input: UpdateDesktopWorkStyleInput): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopWorkStyle(input.workStyle)) {
      throw new Error("未知的工作风格，请选择务实或高效。")
    }
    return this.withDaemonRetry(async (client) => {
      const settings = await client.system.patchSettings({ workStyle: input.workStyle })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences())
    })
  }

  async updateNotificationMode(
    input: UpdateDesktopNotificationModeInput
  ): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopNotificationMode(input.notificationMode)) {
      throw new Error("未知的通知设置，请选择从不、仅失去焦点时或始终。")
    }
    const preferences = this.dependencies.patchPreferences({
      notificationMode: input.notificationMode,
    })
    return this.snapshotWithPreferences(preferences)
  }

  async updateDefaultOpener(
    input: UpdateDesktopDefaultOpenerInput
  ): Promise<DesktopSettingsSnapshot> {
    const defaultOpenerId = normalizeDefaultOpenerId(input.defaultOpenerId)
    if (!defaultOpenerId) throw new Error("打开方式不能为空。")
    const preferences = this.dependencies.patchPreferences({ defaultOpenerId })
    return this.snapshotWithPreferences(preferences)
  }

  async updateDefaultTerminalShell(
    input: UpdateDesktopDefaultTerminalShellInput
  ): Promise<DesktopSettingsSnapshot> {
    const defaultTerminalShellId = normalizeDefaultTerminalShellId(input.defaultTerminalShellId)
    const preferences = this.dependencies.patchPreferences({ defaultTerminalShellId })
    return this.snapshotWithPreferences(preferences)
  }

  async updateAgentEnvironment(
    input: UpdateDesktopAgentEnvironmentInput
  ): Promise<DesktopSettingsSnapshot> {
    if (input.environment !== "native" && input.environment !== "wsl") {
      throw new Error("未知的智能体运行环境，请选择本机或 WSL。")
    }
    return this.withDaemonRetry(async (client) => {
      const settings = await client.system.patchSettings({
        agentEnvironment: { kind: input.environment },
      })
      const capabilities = await client.protocol.capabilities()
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences(), {
        restartRequired: true,
        wslSupported: capabilities.agentEnvironments?.wsl ?? false,
      })
    })
  }

  private async snapshotWithPreferences(
    preferences: DesktopPreferences
  ): Promise<DesktopSettingsSnapshot> {
    try {
      return await this.withDaemonRetry(async (client) => {
        const [settings, capabilities] = await Promise.all([
          client.system.getSettings(),
          client.protocol.capabilities(),
        ])
        return buildDesktopSettingsSnapshot(settings, preferences, {
          wslSupported: capabilities.agentEnvironments?.wsl ?? false,
        })
      })
    } catch {
      return buildDesktopSettingsSnapshot({}, preferences, {
        wslSupported: false,
      })
    }
  }

  private async withDaemonRetry<T>(operation: (client: SettingsClient) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.dependencies.daemonClient())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !message.includes("Failed to fetch") &&
        !message.includes("ECONNREFUSED") &&
        !message.includes("ECONNRESET")
      ) {
        throw error
      }
      return await operation(await this.dependencies.refreshDaemonClient())
    }
  }
}

export const desktopSettingsService = new DesktopSettingsService()
