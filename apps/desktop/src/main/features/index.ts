import type { IpcContribution } from "../core/ipc/types"
import { attachmentIpcContribution } from "./attachment/ipc"
import { browserIpcContribution } from "./browser/ipc"
import { channelIpcContribution } from "./channels/ipc"
import { clipboardIpcContribution } from "./clipboard/ipc"
import { daemonAutoStartIpcContribution } from "./daemon-autostart/ipc"
import { gitIpcContribution } from "./git/ipc"
import { mcpIpcContribution } from "./mcp/ipc"
import { petIpcContribution } from "./pet/ipc"
import { pluginIpcContribution } from "./plugin/ipc"
import { pluginUiIpcContribution } from "./plugin-ui/ipc"
import { providerIpcContribution } from "./provider/ipc"
import { sessionIpcContribution } from "./session/ipc"
import { scheduleIpcContribution } from "./schedule/ipc"
import { noteIpcContribution } from "./notes/ipc"
import { settingsIpcContribution } from "./settings/ipc"
import { terminalSettingsIpcContribution } from "./settings/terminal-settings-ipc"
import { gitSettingsIpcContribution } from "./settings/git-settings-ipc"
import { maintenanceSettingsIpcContribution } from "./settings/maintenance-settings-ipc"
import { runtimeSettingsIpcContribution } from "./settings/runtime-settings-ipc"
import { notificationSettingsIpcContribution } from "./settings/notification-settings-ipc"
import { personalizationManagementIpcContribution } from "./settings/personalization-management-ipc"
import { configurationSettingsIpcContribution } from "./settings/configuration-settings-ipc"
import { providerDefaultsIpcContribution } from "./provider/provider-defaults-ipc"
import { skillIpcContribution } from "./skill/ipc"
import { terminalIpcContribution } from "./terminal/ipc"
import { trayIpcContribution } from "./tray/ipc"
import { windowControlsIpcContribution } from "./window-controls/ipc"
import { workspaceIpcContribution } from "./workspace/ipc"

export const allIpcContributions: IpcContribution[] = [
  daemonAutoStartIpcContribution,
  attachmentIpcContribution,
  browserIpcContribution,
  windowControlsIpcContribution,
  trayIpcContribution,
  petIpcContribution,
  pluginIpcContribution,
  pluginUiIpcContribution,
  skillIpcContribution,
  providerIpcContribution,
  clipboardIpcContribution,
  gitIpcContribution,
  mcpIpcContribution,
  channelIpcContribution,
  sessionIpcContribution,
  scheduleIpcContribution,
  noteIpcContribution,
  settingsIpcContribution,
  terminalSettingsIpcContribution,
  gitSettingsIpcContribution,
  maintenanceSettingsIpcContribution,
  runtimeSettingsIpcContribution,
  notificationSettingsIpcContribution,
  personalizationManagementIpcContribution,
  configurationSettingsIpcContribution,
  providerDefaultsIpcContribution,
  terminalIpcContribution,
  workspaceIpcContribution,
]
