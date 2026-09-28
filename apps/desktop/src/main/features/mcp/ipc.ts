import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopMcpAddInput,
  DesktopMcpGetConfigInput,
  DesktopMcpLoginInput,
  DesktopMcpLoginOperationInput,
  DesktopMcpLogoutInput,
  DesktopMcpRemoveInput,
  DesktopMcpSetEnabledInput,
  DesktopMcpUpdateInput,
} from "../../../shared/mcp-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopMcpService } from "./mcp-service"

export const mcpIpcContribution: IpcContribution = {
  id: "mcp",
  register() {
    return [
      { channel: IpcChannels.mcpSnapshot, handler: () => desktopMcpService.snapshot() },
      {
        channel: IpcChannels.mcpGetConfig,
        handler: (_event, input) => desktopMcpService.getConfig(input as DesktopMcpGetConfigInput),
      },
      { channel: IpcChannels.mcpExportConfig, handler: () => desktopMcpService.exportConfig() },
      {
        channel: IpcChannels.mcpAdd,
        handler: (_event, input) => desktopMcpService.add(input as DesktopMcpAddInput),
      },
      {
        channel: IpcChannels.mcpUpdate,
        handler: (_event, input) => desktopMcpService.update(input as DesktopMcpUpdateInput),
      },
      {
        channel: IpcChannels.mcpRemove,
        handler: (_event, input) => desktopMcpService.remove(input as DesktopMcpRemoveInput),
      },
      {
        channel: IpcChannels.mcpSetEnabled,
        handler: (_event, input) => desktopMcpService.setEnabled(input as DesktopMcpSetEnabledInput),
      },
      {
        channel: IpcChannels.mcpLogin,
        handler: (event, input) => desktopMcpService.login(input as DesktopMcpLoginInput, event.sender),
      },
      {
        channel: IpcChannels.mcpLoginStatus,
        handler: (_event, input) => desktopMcpService.loginStatus(input as DesktopMcpLoginOperationInput),
      },
      {
        channel: IpcChannels.mcpCancelLogin,
        handler: (_event, input) => desktopMcpService.cancelLogin(input as DesktopMcpLoginOperationInput),
      },
      {
        channel: IpcChannels.mcpLogout,
        handler: (_event, input) => desktopMcpService.logout(input as DesktopMcpLogoutInput),
      },
    ]
  },
}
