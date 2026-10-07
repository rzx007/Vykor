import {
  GitSettingsChannels,
  type GitSettingsScope,
  type UpdateGitIdentityInput,
  type UpdateGitPreferencesInput,
} from "../../../shared/git-settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { gitSettingsService } from "./git-settings-service"
import { getGitPreferences } from "./git-settings-storage"
export const gitSettingsIpcContribution: IpcContribution = {
  id: "git-settings",
  register() {
    return [
      { channel: GitSettingsChannels.readPreferences, handler: () => getGitPreferences() },
      {
        channel: GitSettingsChannels.snapshot,
        handler: (_event, input) => gitSettingsService.snapshot(input as GitSettingsScope),
      },
      {
        channel: GitSettingsChannels.preferences,
        handler: (_event, input) =>
          gitSettingsService.updatePreferences(input as UpdateGitPreferencesInput),
      },
      {
        channel: GitSettingsChannels.identity,
        handler: (_event, input) =>
          gitSettingsService.updateIdentity(input as UpdateGitIdentityInput),
      },
      {
        channel: GitSettingsChannels.cleanup,
        handler: (_event, input) => gitSettingsService.cleanup(input as { id: string }),
      },
      {
        channel: GitSettingsChannels.markDisposable,
        handler: (_event, input) =>
          gitSettingsService.markDisposable(input as { id: string; disposable: boolean }),
      },
      {
        channel: GitSettingsChannels.chooseDirectory,
        handler: () => gitSettingsService.chooseDirectory(),
      },
    ]
  },
}
