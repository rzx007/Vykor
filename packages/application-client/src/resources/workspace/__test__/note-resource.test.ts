import { describe, expect, it, vi } from "vitest";
import { NoteResource } from "../note-resource.js";
import type { HttpTransport } from "@rzx/client";

describe("NoteResource organization", () => {
  it("returns snapshots and sends conditional organization input unchanged", async () => {
    const snapshot = {
      organization: {
        version: 1 as const,
        folders: {},
        desktop: [],
        folderItems: {},
      },
      etag: "e1",
      readOnly: false,
    };
    const request = vi.fn(async () => snapshot);
    const resource = new NoteResource({ request } as unknown as HttpTransport);
    await expect(resource.organization()).resolves.toBe(snapshot);
    expect(request).toHaveBeenNthCalledWith(1, "/notes/organization");
    const input = {
      organization: snapshot.organization,
      expectedEtag: snapshot.etag,
    };
    await expect(resource.saveOrganization(input)).resolves.toBe(snapshot);
    expect(request).toHaveBeenNthCalledWith(2, "/notes/organization", {
      method: "PUT",
      body: input,
    });
  });
});
