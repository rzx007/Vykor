import { join } from "node:path"
import { VykorApiError } from "@rzx/client"
import { getDesktopDataDir } from "@vykor/host-config/paths"
import {
  parseCreateNoteInput,
  parseSaveNoteOrganizationInput,
  parseUpdateNoteInput,
  ProtocolValidationError,
} from "@vykor/protocol"
import {
  NoteOrganizationConflictError,
  NoteRevisionConflictError,
  noteFilePath,
  type NoteRepository,
} from "@vykor/services/notes"
import type { DesktopNote, DesktopNoteOrganizationSnapshot } from "../../../shared/note-types"
import { openDesktopNotes } from "./desktop-note-repository"

type NotesHandle = {
  repository: Pick<NoteRepository, "list" | "create" | "update" | "remove" | "organization" | "saveOrganization">
  backupTo(destination: string): Promise<void>
  close(): void
}

interface DesktopNoteServiceOptions {
  directory(): string
  open(directory: string): Promise<NotesHandle>
  openPath(directory: string): Promise<string>
}

const defaults: DesktopNoteServiceOptions = {
  directory: () => join(getDesktopDataDir(), "notes"),
  open: openDesktopNotes,
  openPath: async (directory) => (await import("electron")).shell.openPath(directory),
}

export class DesktopNoteService {
  private pending = Promise.resolve()
  private handle?: NotesHandle
  private closing?: Promise<void>

  constructor(private readonly options: DesktopNoteServiceOptions = defaults) {}

  initialize(): Promise<void> {
    return this.run(() => {})
  }

  organization(): Promise<DesktopNoteOrganizationSnapshot> {
    return this.run((handle) => handle.repository.organization())
  }

  async saveOrganization(value: unknown): Promise<DesktopNoteOrganizationSnapshot> {
    const { organization, expectedEtag } = validate(() => parseSaveNoteOrganizationInput(value))
    return this.run((handle) => handle.repository.saveOrganization(organization, expectedEtag))
  }

  async openDirectory(): Promise<void> {
    const directory = await this.run(() => this.options.directory())
    const error = await this.options.openPath(directory)
    if (error) throw new Error(`无法打开便签文件夹：${error}`)
  }

  list(): Promise<DesktopNote[]> {
    return this.run((handle) => handle.repository.list())
  }

  async create(value: unknown): Promise<DesktopNote> {
    const input = validate(() => parseCreateNoteInput(value))
    return this.run((handle) => handle.repository.create(input))
  }

  async update(id: unknown, value: unknown): Promise<DesktopNote> {
    const noteId = parseId(id)
    const input = validate(() => parseUpdateNoteInput(value))
    return this.run((handle) => handle.repository.update(noteId, input))
  }

  async remove(id: unknown): Promise<void> {
    const noteId = parseId(id)
    return this.run((handle) => {
      if (!handle.repository.remove(noteId)) throw noteError(404, `Note not found: ${noteId}`)
    })
  }

  backupTo(destination: string): Promise<void> {
    return this.run((handle) => handle.backupTo(destination))
  }

  flush(): Promise<void> {
    return this.pending
  }

  reconcileBeforeMove(): Promise<void> {
    return this.enqueue(async () => {
      const repository = this.handle?.repository
      if (!repository) return
      repository.list()
      await repository.organization()
    })
  }

  close(): Promise<void> {
    return this.closing ??= this.enqueue(() => {
      this.handle?.close()
      this.handle = undefined
    }).catch((error) => {
      this.closing = undefined
      throw error
    })
  }

  private run<T>(operation: (handle: NotesHandle) => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("便签已关闭，请重新启动桌面。"))
    return this.enqueue(async () => {
      this.handle ??= await this.options.open(this.options.directory())
      try { return await operation(this.handle) }
      catch (error) {
        if (error instanceof VykorApiError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof NoteRevisionConflictError || error instanceof NoteOrganizationConflictError)
          throw noteError(409, message)
        if (error instanceof ProtocolValidationError) throw validationError(error)
        if (message.startsWith("Note not found:")) throw noteError(404, message)
        throw noteError(500, message)
      }
    })
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => {}, () => {})
    return result
  }
}

export const desktopNoteService = new DesktopNoteService()

function parseId(id: unknown): string {
  if (typeof id !== "string") throw noteError(400, "Invalid note file ID")
  try { noteFilePath("", id) }
  catch { throw noteError(400, "Invalid note file ID") }
  return id
}

function validate<T>(parse: () => T): T {
  try { return parse() }
  catch (error) {
    if (error instanceof ProtocolValidationError) throw validationError(error)
    throw error
  }
}

function validationError(error: ProtocolValidationError): VykorApiError {
  return new VykorApiError(error.message, 400, error.toProtocolError())
}

function noteError(status: number, error: string): VykorApiError {
  return new VykorApiError(error, status, { error })
}
