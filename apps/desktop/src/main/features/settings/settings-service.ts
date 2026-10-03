import type { ProtocolClient, SystemResource } from "@vykor/client"

import {
  buildDesktopSettingsSnapshot,
  isDesktopNotificationMode,
  isDesktopSoundId,
  isDesktopWorkStyle,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
} from "../../../shared/settings-types"
import type {
  DesktopSettingsSnapshot,
  UpdateDesktopAgentEnvironmentInput,
  UpdateDesktopBrowserDeveloperModeInput,
  UpdateDesktopCustomInstructionsInput,
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  UpdateDesktopNotificationSoundsInput,
  UpdateDesktopMemorySettingsInput,
  UpdateDesktopReasoningVisibilityInput,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import { desktopSessionService } from "../session/session-service"
import { browserAgentService } from "../browser/browser-agent-service"
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

  async updateCustomInstructions(
    input: UpdateDesktopCustomInstructionsInput
  ): Promise<DesktopSettingsSnapshot> {
    if (typeof input.content !== "string") throw new Error("自定义指令必须是文本。")
    return this.withDaemonRetry(async (client) => {
      const settings = await client.system.patchSettings({ systemPrompt: input.content })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences())
    })
  }

  async updateMemorySettings(
    input: UpdateDesktopMemorySettingsInput
  ): Promise<DesktopSettingsSnapshot> {
    if (
      (input.enabled === undefined && input.autoExtractEnabled === undefined) ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      (input.autoExtractEnabled !== undefined && typeof input.autoExtractEnabled !== "boolean")
    )
      throw new Error("记忆设置必须是开关值。")
    return this.withDaemonRetry(async (client) => {
      const settings = await client.system.patchSettings({ memory: input })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences())
    })
  }

  async updateReasoningVisibility(
    input: UpdateDesktopReasoningVisibilityInput
  ): Promise<DesktopSettingsSnapshot> {
    if (typeof input.showReasoning !== "boolean") {
      throw new Error("思考过程展示开关必须是布尔值。")
    }
    return this.withDaemonRetry(async (client) => {
      const settings = await client.system.patchSettings({ showReasoning: input.showReasoning })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences())
    })
  }

  async updateBrowserDeveloperMode(
    input: UpdateDesktopBrowserDeveloperModeInput
  ): Promise<DesktopSettingsSnapshot> {
    if (typeof input.enabled !== "boolean") {
      throw new Error("Developer mode must be a boolean.")
    }
    const preferences = this.dependencies.patchPreferences({
      browserDeveloperMode: input.enabled,
    })
    // Turning the switch off must immediately tear down any active capture,
    // not just block the next tool call.
    if (!input.enabled) browserAgentService.stopDeveloperDiagnostics()
    return this.snapshotWithPreferences(preferences)
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

  async updateNotificationSounds(
    input: UpdateDesktopNotificationSoundsInput
  ): Promise<DesktopSettingsSnapshot> {
    const sounds = input?.notificationSounds
    if (
      !sounds ||
      !isDesktopSoundId(sounds.completed) ||
      !isDesktopSoundId(sounds.needs_input) ||
      !isDesktopSoundId(sounds.failed)
    ) {
      throw new Error("请选择列表中的音效，或选择无声音。")
    }
    const preferences = this.dependencies.patchPreferences({ notificationSounds: sounds })
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
