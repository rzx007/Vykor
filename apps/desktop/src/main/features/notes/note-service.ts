import type { VykorClient } from "@vykor/client"

import type {
  CreateDesktopNoteInput,
  DesktopNote,
  UpdateDesktopNoteInput,
} from "../../../shared/note-types"
import { desktopSessionService } from "../session/session-service"

type NoteClient = Pick<VykorClient, "notes">

export class DesktopNoteService {
  list(): Promise<DesktopNote[]> {
    return withDaemonRetry((client) => client.notes.list())
  }

  create(input: CreateDesktopNoteInput): Promise<DesktopNote> {
    return withDaemonRetry((client) => client.notes.create(input))
  }

  update(id: string, input: UpdateDesktopNoteInput): Promise<DesktopNote> {
    return withDaemonRetry((client) => client.notes.update(id, input))
  }

  async remove(id: string): Promise<void> {
    await withDaemonRetry((client) => client.notes.remove(id))
  }
}

export const desktopNoteService = new DesktopNoteService()

async function withDaemonRetry<T>(operation: (client: NoteClient) => Promise<T>): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}
