import type { CreateNoteInput, NoteRecord, UpdateNoteInput } from "@vykor/client"
import { IpcChannels } from "../../../shared/ipc-channels"
import { describe, expect, it, vi } from "vitest"

interface NoteService {
  list(): Promise<NoteRecord[]>
  create(input: CreateNoteInput): Promise<NoteRecord>
  update(id: string, input: UpdateNoteInput): Promise<NoteRecord>
  remove(id: string): Promise<void>
}

async function loadContribution(service: NoteService) {
  const path = "./ipc"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    createNoteIpcContribution(service: NoteService): {
      register(context: unknown): Array<{
        channel: string
        handler(event: unknown, ...args: unknown[]): unknown
      }>
    }
  }
  expect(module).not.toBeNull()
  return module!.createNoteIpcContribution(service)
}

describe("note IPC contribution", () => {
  it("routes the four note operations without changing their arguments", async () => {
    const note: NoteRecord = {
      id: "n1",
      content: "idea",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const service = {
      list: vi.fn(async () => [note]),
      create: vi.fn(async () => note),
      update: vi.fn(async () => ({ ...note, content: "changed", revision: 2 })),
      remove: vi.fn(async () => undefined),
    }
    const registrations = (await loadContribution(service)).register({} as never)
    const handler = (channel: string) =>
      registrations.find((registration) => registration.channel === channel)!.handler

    await expect(handler(IpcChannels.noteList)({})).resolves.toEqual([note])
    await handler(IpcChannels.noteCreate)({}, { content: "idea" })
    await handler(IpcChannels.noteUpdate)({}, "n1", {
      content: "changed",
      expectedRevision: 1,
    })
    await handler(IpcChannels.noteRemove)({}, "n1")

    expect(service.create).toHaveBeenCalledWith({ content: "idea" })
    expect(service.update).toHaveBeenCalledWith("n1", {
      content: "changed",
      expectedRevision: 1,
    })
    expect(service.remove).toHaveBeenCalledWith("n1")
  })
})
