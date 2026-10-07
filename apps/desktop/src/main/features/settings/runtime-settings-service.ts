import { checkRuntimeEnvironment, inspectRuntimeEnvironment, listRuntimeDistributions, saveRuntimeEnvironment } from "@vykor/server"
import { desktopSessionService } from "../session/session-service"
import type { RuntimeEnvironmentConfig } from "../../../shared/runtime-settings-types"

export class DesktopRuntimeSettingsService {
  async snapshot(input: { cwd?: string } = {}) {
    const client = await desktopSessionService.daemonClient()
    const settings = await client.system.getSettings()
    const activeDefault = settings.runtimeEnvironmentActive as RuntimeEnvironmentConfig | undefined
    const override = settings.runtimeEnvironmentKindOverride
    return { ...await inspectRuntimeEnvironment({ ...input, activeDefault, kindOverride: override === "native" || override === "wsl" ? override : undefined }), distributions: await listRuntimeDistributions() }
  }
  async save(input: { cwd?: string; config: RuntimeEnvironmentConfig | null; expected: RuntimeEnvironmentConfig | null; secrets?: Record<string, string | null>; expectedSecretRevision?: string }) {
    await saveRuntimeEnvironment(input)
    try {
      const client = await desktopSessionService.daemonClient()
      await client.system.patchSettings({ runtimeEnvironmentChanged: true })
      return await this.snapshot({ cwd: input.cwd })
    } catch { throw new Error("运行环境已保存，但后台刷新失败。请重新读取；用户默认需要后台重启后采用，不必重复保存。") }
  }
  check(input: { cwd: string; config: RuntimeEnvironmentConfig }) { return checkRuntimeEnvironment(input) }
  async restart(input: { stopActive?: boolean } = {}) { await desktopSessionService.restartDaemon(input); return this.snapshot() }
}
export const desktopRuntimeSettingsService = new DesktopRuntimeSettingsService()
