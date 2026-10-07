import { RuntimeSettingsChannels, type RuntimeSettingsAPI } from "../../../shared/runtime-settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopRuntimeSettingsService } from "./runtime-settings-service"
export const runtimeSettingsIpcContribution: IpcContribution = {
  id: "runtime-settings", register: () => [
    { channel: RuntimeSettingsChannels.snapshot, handler: (_event, input) => desktopRuntimeSettingsService.snapshot(input as Parameters<RuntimeSettingsAPI["snapshot"]>[0]) },
    { channel: RuntimeSettingsChannels.save, handler: (_event, input) => desktopRuntimeSettingsService.save(input as Parameters<RuntimeSettingsAPI["save"]>[0]) },
    { channel: RuntimeSettingsChannels.check, handler: (_event, input) => desktopRuntimeSettingsService.check(input as Parameters<RuntimeSettingsAPI["check"]>[0]) },
    { channel: RuntimeSettingsChannels.restart, handler: (_event, input) => desktopRuntimeSettingsService.restart(input as Parameters<RuntimeSettingsAPI["restart"]>[0]) },
  ],
}
