import type { CreateDesktopNoteInput, UpdateDesktopNoteInput } from "../../../shared/note-types"
import { IpcChannels } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopNoteService, type DesktopNoteService } from "./note-service"

export function createNoteIpcContribution(
  service: Pick<DesktopNoteService, "list" | "create" | "update" | "remove" | "openDirectory">
): IpcContribution {
  return {
    id: "notes",
    register() {
      return [
        { channel: IpcChannels.noteOpenDirectory, handler: () => service.openDirectory() },
        { channel: IpcChannels.noteList, handler: () => service.list() },
        {
          channel: IpcChannels.noteCreate,
          handler: (_event, input) => service.create(input as CreateDesktopNoteInput),
        },
        {
          channel: IpcChannels.noteUpdate,
          handler: (_event, id, input) =>
            service.update(String(id), input as UpdateDesktopNoteInput),
        },
        {
          channel: IpcChannels.noteRemove,
          handler: (_event, id) => service.remove(String(id)),
        },
      ]
    },
  }
}

export const noteIpcContribution = createNoteIpcContribution(desktopNoteService)
