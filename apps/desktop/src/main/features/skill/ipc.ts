import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopSkillMarketplaceInstallInput,
  DesktopSkillRemoveInput,
  DesktopSkillSnapshotInput,
} from "../../../shared/skill-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSkillService } from "./skill-service"

export const skillIpcContribution: IpcContribution = {
  id: "skill",
  register() {
    return [
      {
        channel: IpcChannels.skillMarketplace,
        handler: () => desktopSkillService.marketplace(),
      },
      {
        channel: IpcChannels.skillMarketplaceInstall,
        handler: (_event, input) =>
          desktopSkillService.installMarketplace(input as DesktopSkillMarketplaceInstallInput),
      },
      {
        channel: IpcChannels.skillSnapshot,
        handler: (_event, input) =>
          desktopSkillService.snapshot(input as DesktopSkillSnapshotInput),
      },
      {
        channel: IpcChannels.skillRemove,
        handler: (_event, input) => desktopSkillService.remove(input as DesktopSkillRemoveInput),
      },
    ]
  },
}
