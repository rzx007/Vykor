import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
  NoteOrganizationSnapshotRecord,
  SaveNoteOrganizationInput,
} from "@vykor/application-client"
import { IpcChannels } from "../../../shared/ipc-channels"
import { describe, expect, it, vi } from "vitest"

// This unit exercises injected note operations; do not start the Desktop singleton graph.
vi.mock("./note-service", () => ({ desktopNoteService: {} }))

interface NoteService {
  list(): Promise<NoteRecord[]>
  create(input: CreateNoteInput): Promise<NoteRecord>
  update(id: string, input: UpdateNoteInput): Promise<NoteRecord>
  remove(id: string): Promise<void>
  openDirectory(): Promise<void>
  organization(): Promise<NoteOrganizationSnapshotRecord>
  saveOrganization(input: SaveNoteOrganizationInput): Promise<NoteOrganizationSnapshotRecord>
}

async function loadContribution(service: NoteService) {
  const path = "./ipc"
  const module = (await import(/* @vite-ignore */ path)) as {
    createNoteIpcContribution(service: NoteService): {
      register(context: unknown): Array<{
        channel: string
        handler(event: unknown, ...args: unknown[]): unknown
      }>
    }
  }
  return module.createNoteIpcContribution(service)
}

describe("note IPC contribution", () => {
  it("routes note operations and opens only the service-owned directory", async () => {
    const note: NoteRecord = {
      id: "n1",
      content: "idea",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const service = {
      organization: vi.fn(async () => ({
        organization: { version: 1 as const, folders: {}, desktop: [], folderItems: {} },
        etag: "e1",
        readOnly: false,
      })),
      saveOrganization: vi.fn(async (input: SaveNoteOrganizationInput) => ({
        organization: input.organization,
        etag: "e2",
        readOnly: false,
      })),
      list: vi.fn(async () => [note]),
      create: vi.fn(async () => note),
      update: vi.fn(async () => ({ ...note, content: "changed", revision: 2 })),
      remove: vi.fn(async () => undefined),
      openDirectory: vi.fn(async () => undefined),
    }
    const registrations = (await loadContribution(service)).register({} as never)
    const handler = (channel: string) =>
      registrations.find((registration) => registration.channel === channel)!.handler

    await expect(handler(IpcChannels.noteList)({})).resolves.toEqual([note])
    const snapshot = (await handler(IpcChannels.noteOrganizationGet)(
      {}
    )) as NoteOrganizationSnapshotRecord
    const input = { organization: snapshot.organization, expectedEtag: snapshot.etag }
    await expect(handler(IpcChannels.noteOrganizationSave)({}, input)).resolves.toMatchObject({
      etag: "e2",
    })
    expect(service.saveOrganization).toHaveBeenCalledWith(input)
    await handler(IpcChannels.noteCreate)({}, { content: "idea" })
    await handler(IpcChannels.noteUpdate)({}, "n1", {
      content: "changed",
      expectedRevision: 1,
    })
    await handler(IpcChannels.noteRemove)({}, "n1")
    await handler(IpcChannels.noteOpenDirectory)({}, "D:/untrusted-path")

    expect(service.create).toHaveBeenCalledWith({ content: "idea" })
    expect(service.update).toHaveBeenCalledWith("n1", {
      content: "changed",
      expectedRevision: 1,
    })
    expect(service.remove).toHaveBeenCalledWith("n1")
    expect(service.openDirectory).toHaveBeenCalledWith()
  })
})
