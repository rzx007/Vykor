import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopGitChangesInput,
  DesktopGitFileDiffInput,
  DesktopGitIsRepositoryInput,
} from "../../../shared/git-types"
import type { IpcContribution } from "../../core/ipc/types"
import { gitService } from "./git-service"

export const gitIpcContribution: IpcContribution = {
  id: "git",
  register() {
    return [
      {
        channel: IpcChannels.gitChanges,
        handler: (_event, input) => gitService.changes(input as DesktopGitChangesInput),
      },
      {
        channel: IpcChannels.gitFileDiff,
        handler: (_event, input) => gitService.fileDiff(input as DesktopGitFileDiffInput),
      },
      {
        channel: IpcChannels.gitIsRepository,
        handler: (_event, input) => gitService.isRepository(input as DesktopGitIsRepositoryInput),
      },
    ]
  },
}
