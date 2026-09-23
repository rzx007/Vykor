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
import { providerIpcContribution } from "./provider/ipc"
import { sessionIpcContribution } from "./session/ipc"
import { scheduleIpcContribution } from "./schedule/ipc"
import { settingsIpcContribution } from "./settings/ipc"
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
  skillIpcContribution,
  providerIpcContribution,
  clipboardIpcContribution,
  gitIpcContribution,
  mcpIpcContribution,
  channelIpcContribution,
  sessionIpcContribution,
  scheduleIpcContribution,
  settingsIpcContribution,
  terminalIpcContribution,
  workspaceIpcContribution,
]
