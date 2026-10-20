import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  WorkspaceCopyPathInput,
  WorkspaceListFilesInput,
  WorkspaceOpenWithInput,
  WorkspaceReadFileInput,
  WorkspaceWriteFileInput,
  WorkspaceRevealPathInput,
} from "../../../shared/workspace-types"
import type { IpcContribution } from "../../core/ipc/types"
import { openerService } from "./opener-service"
import { workspaceService } from "./workspace-service"

export const workspaceIpcContribution: IpcContribution = {
  id: "workspace",
  register() {
    return [
      {
        channel: IpcChannels.workspaceListFiles,
        handler: (_event, input) => workspaceService.listFiles(input as WorkspaceListFilesInput),
      },
      {
        channel: IpcChannels.workspaceReadFile,
        handler: (_event, input) => workspaceService.readFile(input as WorkspaceReadFileInput),
      },
      {
        channel: IpcChannels.workspaceWriteFile,
        handler: (_event, input) => workspaceService.writeFile(input as WorkspaceWriteFileInput),
      },
      {
        channel: IpcChannels.workspaceRevealPath,
        handler: (_event, input) => workspaceService.revealPath(input as WorkspaceRevealPathInput),
      },
      {
        channel: IpcChannels.workspaceCopyPath,
        handler: (_event, input) => workspaceService.copyPath(input as WorkspaceCopyPathInput),
      },
      {
        channel: IpcChannels.workspaceListOpeners,
        handler: () => openerService.listOpeners(),
      },
      {
        channel: IpcChannels.workspaceOpenWith,
        handler: (_event, input) => {
          const payload = input as WorkspaceOpenWithInput
          return openerService.openWith(payload.openerId, payload.path, payload.rootPath)
        },
      },
    ]
  },
}
