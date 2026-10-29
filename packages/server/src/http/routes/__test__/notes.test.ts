import { createNoteApplicationService } from "../../../application/notes/note-application-service.js";
import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
  NoteOrganizationSnapshotRecord,
  NoteOrganizationV1Record,
} from "@vykor/protocol";
import {
  NoteRevisionConflictError,
  NoteOrganizationConflictError,
  NoteOrganizationReadOnlyError,
} from "@vykor/services";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

interface NotesPort {
  list(): NoteRecord[];
  create(input: CreateNoteInput): NoteRecord;
  update(id: string, input: UpdateNoteInput): NoteRecord;
  remove(id: string): boolean;
  storageInfo?(): { directory: string; format: "markdown" };
  organization?(): NoteOrganizationSnapshotRecord;
  saveOrganization?(
    organization: NoteOrganizationV1Record,
    expectedEtag: string,
  ): Promise<NoteOrganizationSnapshotRecord>;
}

async function createApp(notes: NotesPort): Promise<Hono> {
  const path = "../notes.js";
  const module = (await import(/* @vite-ignore */ path).catch(
    () => null,
  )) as null | {
    createNoteRoutes(context: { notes: NotesPort }): Hono;
  };
  expect(module).not.toBeNull();
  return new Hono().route(
    "/notes",
    module!.createNoteRoutes({
      notes: createNoteApplicationService({ notes }),
    }),
  );
}

const note: NoteRecord = {
  id: "n1",
  content: "idea",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("note routes", () => {
  it("gets organization, conditionally saves it and rejects invalid ownership before storage", async () => {
    const organization: NoteOrganizationV1Record = {
      version: 1,
      folders: {},
      desktop: [{ type: "note", id: "a" }],
      folderItems: {},
    };
    const snapshot = { organization, etag: "etag-2", readOnly: false };
    const saveOrganization = vi.fn(async () => snapshot);
    const app = await createApp({
      list: () => [],
      create: () => note,
      update: () => note,
      remove: () => true,
      organization: () => snapshot,
      saveOrganization,
    });
    await expect(
      (await app.request("/notes/organization")).json(),
    ).resolves.toEqual(snapshot);
    const put = (value: unknown) =>
      app.request("/notes/organization", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect((await put({ organization, expectedEtag: "etag-1" })).status).toBe(
      200,
    );
    expect(saveOrganization).toHaveBeenCalledWith(organization, "etag-1");
    saveOrganization.mockClear();
    expect(
      (
        await put({
          organization: {
            ...organization,
            desktop: [...organization.desktop, ...organization.desktop],
          },
          expectedEtag: "etag-1",
        })
      ).status,
    ).toBe(400);
    expect(saveOrganization).not.toHaveBeenCalled();
    saveOrganization.mockRejectedValueOnce(new NoteOrganizationConflictError());
    expect((await put({ organization, expectedEtag: "etag-1" })).status).toBe(
      409,
    );
    saveOrganization.mockRejectedValueOnce(new NoteOrganizationReadOnlyError());
    expect((await put({ organization, expectedEtag: "etag-1" })).status).toBe(
      409,
    );
  });
  it("returns the repository-owned Markdown directory", async () => {
    const directory = "D:/user-data/session-runtime/notes";
    const app = await createApp({
      list: () => [],
      create: () => note,
      update: () => note,
      remove: () => false,
      storageInfo() {
        return { directory, format: "markdown" };
      },
    });
    const response = await app.request("/notes/storage");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      directory,
      format: "markdown",
    });
  });

  it("lists, creates, updates and removes notes", async () => {
    const app = await createApp({
      list: () => [note],
      create: (input) => ({ ...note, content: input.content }),
      update: (id, input) => ({
        ...note,
        id,
        content: input.content,
        revision: input.expectedRevision + 1,
      }),
      remove: () => true,
    });

    await expect((await app.request("/notes")).json()).resolves.toEqual({
      notes: [note],
    });
    const created = await app.request("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "created" }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      note: { content: "created" },
    });

    const updated = await app.request("/notes/n1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "changed", expectedRevision: 1 }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      note: { id: "n1", content: "changed", revision: 2 },
    });
    expect((await app.request("/notes/n1", { method: "DELETE" })).status).toBe(
      200,
    );
  });

  it("rejects invalid create content before reaching the repository", async () => {
    const create = vi.fn(() => note);
    const app = await createApp({
      list: () => [],
      create,
      update: () => note,
      remove: () => true,
    });
    const response = await app.request("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: " " }),
    });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("maps revision conflicts to 409 without hiding the message", async () => {
    const app = await createApp({
      list: () => [],
      create: () => note,
      update: () => {
        throw new NoteRevisionConflictError("n1", 1);
      },
      remove: () => true,
    });
    const response = await app.request("/notes/n1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "changed", expectedRevision: 1 }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Note revision conflict: n1 expected 1",
    });
  });

  it("returns 404 when deleting a missing note", async () => {
    const app = await createApp({
      list: () => [],
      create: () => note,
      update: () => note,
      remove: () => false,
    });
    expect(
      (await app.request("/notes/missing", { method: "DELETE" })).status,
    ).toBe(404);
  });
});
