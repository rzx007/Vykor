import { IpcChannels } from "../../../shared/ipc-channels"
import type { DesktopMcpLoginInput, DesktopMcpLogoutInput } from "../../../shared/mcp-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopMcpService } from "./mcp-service"

export const mcpIpcContribution: IpcContribution = {
  id: "mcp",
  register() {
    return [
      { channel: IpcChannels.mcpSnapshot, handler: () => desktopMcpService.snapshot() },
      {
        channel: IpcChannels.mcpLogin,
        handler: (_event, input) => desktopMcpService.login(input as DesktopMcpLoginInput),
      },
      {
        channel: IpcChannels.mcpLogout,
        handler: (_event, input) => desktopMcpService.logout(input as DesktopMcpLogoutInput),
      },
    ]
  },
}
