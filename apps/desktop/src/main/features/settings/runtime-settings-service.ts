import { checkRuntimeEnvironment, inspectRuntimeEnvironment, listRuntimeDistributions, saveRuntimeEnvironment } from "@vykor/server"
import { desktopSessionService } from "../session/session-service"
import type { RuntimeEnvironmentConfig } from "../../../shared/runtime-settings-types"

export class DesktopRuntimeSettingsService {
  async snapshot(input: { cwd?: string } = {}) {
    const client = await desktopSessionService.daemonClient()
    const settings = await client.system.getSettings()
    const activeDefault = settings.runtimeEnvironmentActive as RuntimeEnvironmentConfig | undefined
    return { ...await inspectRuntimeEnvironment({ ...input, activeDefault }), distributions: await listRuntimeDistributions() }
  }
  async save(input: { cwd?: string; config: RuntimeEnvironmentConfig | null; expected: RuntimeEnvironmentConfig | null; secrets?: Record<string, string | null> }) {
    await saveRuntimeEnvironment(input)
    const client = await desktopSessionService.daemonClient()
    await client.system.patchSettings({ runtimeEnvironmentChanged: true })
    return this.snapshot({ cwd: input.cwd })
  }
  check(input: { cwd: string; config: RuntimeEnvironmentConfig }) { return checkRuntimeEnvironment(input) }
  async restart(input: { stopActive?: boolean } = {}) { await desktopSessionService.restartDaemon(input); return this.snapshot() }
}
export const desktopRuntimeSettingsService = new DesktopRuntimeSettingsService()
