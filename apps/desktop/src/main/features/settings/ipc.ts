import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  UpdateDesktopBrowserDeveloperModeInput,
  UpdateDesktopCustomInstructionsInput,
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  UpdateDesktopMemorySettingsInput,
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
        channel: IpcChannels.settingsUpdateCustomInstructions,
        handler: (_event, input) =>
          desktopSettingsService.updateCustomInstructions(
            input as UpdateDesktopCustomInstructionsInput
          ),
      },
      {
        channel: IpcChannels.settingsUpdateMemorySettings,
        handler: (_event, input) =>
          desktopSettingsService.updateMemorySettings(input as UpdateDesktopMemorySettingsInput),
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
        channel: IpcChannels.settingsUpdateBrowserDeveloperMode,
        handler: (_event, input) =>
          desktopSettingsService.updateBrowserDeveloperMode(
            input as UpdateDesktopBrowserDeveloperModeInput
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
