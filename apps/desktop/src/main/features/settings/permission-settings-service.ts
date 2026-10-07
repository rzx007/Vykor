import { isDeepStrictEqual } from "node:util"
import { isAbsolute } from "node:path"
import type { VykorClient } from "@vykor/client"
import {
  checkPermissionConfiguration,
  inspectPermissionConfiguration,
  validateIsolationConfiguration,
  validatePermissionConfiguration,
} from "@vykor/server"
import type {
  CheckDesktopPermissionInput,
  DesktopIsolationSettings,
  DesktopPermissionSettingsSnapshot,
  RevokeDesktopApprovalInput,
  UpdateDesktopPermissionSettingsInput,
} from "../../../shared/permission-settings-types"
import { desktopSessionService } from "../session/session-service"
import { browserAgentService } from "../browser/browser-agent-service"
import { getDesktopPreferences } from "./desktop-preferences"

interface Dependencies {
  daemonClient(): Promise<Pick<VykorClient, "system" | "permissions">>
  browser: Pick<typeof browserAgentService, "listOriginApprovals" | "revokeOriginApproval">
  getDeveloperMode(): boolean
}

export class DesktopPermissionSettingsService {
  constructor(
    private readonly deps: Dependencies = {
      daemonClient: () => desktopSessionService.daemonClient(),
      browser: browserAgentService,
      getDeveloperMode: () => getDesktopPreferences().browserDeveloperMode === true,
    }
  ) {}

  async snapshot(): Promise<DesktopPermissionSettingsSnapshot> {
    const client = await this.deps.daemonClient()
    const [settings, approvals] = await Promise.all([
      client.system.getSettings(),
      client.permissions.listApprovals(),
    ])
    return {
      ...inspectPermissionConfiguration(settings),
      browserDeveloperMode: this.deps.getDeveloperMode(),
      toolApprovals: approvals.map(({ id, sessionId, toolName, updatedAt }) => ({
        id,
        sessionId,
        toolName,
        updatedAt,
      })),
      browserApprovals: this.deps.browser.listOriginApprovals(),
    }
  }

  async update(
    input: UpdateDesktopPermissionSettingsInput
  ): Promise<DesktopPermissionSettingsSnapshot> {
    const permission = validatePermissionConfiguration(input.permission)
    const client = await this.deps.daemonClient()
    const settings = await client.system.getSettings()
    const current = inspectPermissionConfiguration(settings)
    if (!isDeepStrictEqual(current.permission, input.expectedPermission)) {
      throw new Error("权限规则已被其他窗口或命令修改。请重新读取后保存。")
    }
    // Ask the shared server to persist; its settings owner invalidates future runtimes.
    await client.system.patchSettings({ permission, expectedPermission: input.expectedPermission })
    try {
      return await this.snapshot()
    } catch {
      throw new Error("权限设置已经保存，但状态刷新失败。请重新读取后继续编辑。")
    }
  }

  async updateIsolation(input: {
    sandbox: DesktopIsolationSettings
    expectedSandbox: DesktopIsolationSettings
  }): Promise<DesktopPermissionSettingsSnapshot> {
    const sandbox = validateIsolationConfiguration(input.sandbox)
    const client = await this.deps.daemonClient()
    const settings = await client.system.getSettings()
    const current = inspectPermissionConfiguration(settings)
    if (!isDeepStrictEqual(current.sandbox, input.expectedSandbox))
      throw new Error("访问边界已被其他窗口修改。请重新读取后保存。")
    if (sandbox.enabled) {
      const availability = inspectPermissionConfiguration({ ...settings, sandbox })
      if (!availability.isolationAvailable)
        throw new Error(availability.isolationReason ?? "当前环境无法启用隔离。")
    }
    await client.system.patchSettings({ sandbox, expectedSandbox: input.expectedSandbox })
    try {
      return await this.snapshot()
    } catch {
      throw new Error("访问边界已经保存，但状态刷新失败。请重新读取后继续编辑。")
    }
  }

  async check(input: CheckDesktopPermissionInput) {
    if (typeof input.cwd !== "string" || !isAbsolute(input.cwd))
      throw new Error("请选择用于检查的项目目录。")
    const client = await this.deps.daemonClient()
    const settings = inspectPermissionConfiguration(await client.system.getSettings())
    return checkPermissionConfiguration({ ...input, environment: settings.environment })
  }

  async revoke(input: RevokeDesktopApprovalInput): Promise<DesktopPermissionSettingsSnapshot> {
    if (
      input.kind === "browser" &&
      typeof input.sessionId === "string" &&
      typeof input.origin === "string"
    ) {
      this.deps.browser.revokeOriginApproval(input.sessionId, input.origin)
    } else if (input.kind === "tool" && typeof input.id === "string" && input.id.trim()) {
      const client = await this.deps.daemonClient()
      await client.permissions.revokeApproval(input.id)
    } else throw new Error("授权对象无效，请重新读取授权列表。")
    try {
      return await this.snapshot()
    } catch {
      throw new Error("授权已经撤销，但列表刷新失败。请重新读取。")
    }
  }
}

export const desktopPermissionSettingsService = new DesktopPermissionSettingsService()
