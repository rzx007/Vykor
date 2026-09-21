import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  UpdateDesktopAgentEnvironmentInput,
  UpdateDesktopReasoningVisibilityInput,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSettingsService } from "./settings-service"

export const settingsIpcContribution: IpcContribution = {
  id: "settings",
  register() {
    return [
      {
        channel: IpcChannels.settingsSnapshot,
        handler: () => desktopSettingsService.snapshot(),
      },
      {
        channel: IpcChannels.settingsUpdateWorkStyle,
        handler: (_event, input) =>
          desktopSettingsService.updateWorkStyle(input as UpdateDesktopWorkStyleInput),
      },
      {
        channel: IpcChannels.settingsUpdateNotificationMode,
        handler: (_event, input) =>
          desktopSettingsService.updateNotificationMode(
            input as UpdateDesktopNotificationModeInput
          ),
      },
      {
        channel: IpcChannels.settingsUpdateAgentEnvironment,
        handler: (_event, input) =>
          desktopSettingsService.updateAgentEnvironment(
            input as UpdateDesktopAgentEnvironmentInput
          ),
      },
      {
        channel: IpcChannels.settingsUpdateReasoningVisibility,
        handler: (_event, input) =>
          desktopSettingsService.updateReasoningVisibility(
            input as UpdateDesktopReasoningVisibilityInput
          ),
      },
      {
        channel: IpcChannels.settingsUpdateDefaultOpener,
        handler: (_event, input) =>
          desktopSettingsService.updateDefaultOpener(input as UpdateDesktopDefaultOpenerInput),
      },
      {
        channel: IpcChannels.settingsUpdateDefaultTerminalShell,
        handler: (_event, input) =>
          desktopSettingsService.updateDefaultTerminalShell(
            input as UpdateDesktopDefaultTerminalShellInput
          ),
      },
    ]
  },
}
