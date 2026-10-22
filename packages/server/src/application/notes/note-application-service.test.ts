import { describe, expect, it, vi } from "vitest";
import { NoteRevisionConflictError } from "@vykor/services";
import { createNoteApplicationService } from "./note-application-service.js";
describe("Note application use cases", () => {
  it("rejects writes before ready without touching persistence", () => {
    const create = vi.fn();
    const service = createNoteApplicationService({
      notes: { list: () => [], create, update: vi.fn(), remove: vi.fn() },
      readiness: () => ({ phase: "starting", accepting: false }),
    });
    expect(() => service.create({ content: "draft" })).toThrow("尚未就绪");
    expect(create).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);
  });
  it("maps a revision conflict to a stable application error outside HTTP", () => {
    const service = createNoteApplicationService({
      notes: {
        list: () => [],
        create: vi.fn(),
        update: () => {
          throw new NoteRevisionConflictError("note", 1);
        },
        remove: vi.fn(),
      },
    });
    try {
      service.update("note", { content: "new", expectedRevision: 1 });
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "conflict", status: 409 });
    }
  });
});
