import { IpcChannels } from "../../../shared/ipc-channels"
import type { DesktopUpdateState } from "../../../shared/update-types"
import type { IpcContribution } from "../../core/ipc/types"

export interface UpdateIpcService {
  getState(): DesktopUpdateState
  download(): Promise<void>
  install(): void | Promise<void>
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
}

interface UpdaterIpcDependencies {
  service: UpdateIpcService
  broadcast(state: DesktopUpdateState): void
}

export function createUpdaterIpcContribution({
  service,
  broadcast,
}: UpdaterIpcDependencies): IpcContribution {
  service.subscribe(broadcast)

  return {
    id: "updater",
    register() {
      return [
        {
          channel: IpcChannels.updateGetState,
          handler: () => service.getState(),
        },
        {
          channel: IpcChannels.updateDownload,
          handler: async () => await service.download(),
        },
        {
          channel: IpcChannels.updateInstall,
          handler: () => service.install(),
        },
      ]
    },
  }
}
