import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { expect, it, vi } from "vitest";
import { VykorHttpServer } from "../server.js";

it("returns the authenticated Notes migration response for every retired read and write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-notes-retirement-"));
  const legacyDirectory = join(directory, "notes");
  mkdirSync(legacyDirectory);
  const body = join(legacyDirectory, "old.md");
  writeFileSync(body, "historical Markdown");
  const openLegacyNotes = vi.spyOn(SessionStore.prototype, "openLegacyNotes");
  const server = new VykorHttpServer({ storePath: join(directory, "sessions.db"), token: "notes-test-token", logger: () => {} });
  try {
    await server.application.ready();
    const protocol = { "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) };
    const headers = { ...protocol, authorization: "Bearer notes-test-token", "content-type": "application/json" };
    expect((await server.app.request("/notes", { headers: protocol })).status).toBe(401);
    for (const [method, path] of [
      ["GET", "/notes"], ["GET", "/notes/storage"], ["GET", "/notes/organization"],
      ["POST", "/notes"], ["PUT", "/notes/organization"], ["PATCH", "/notes/old"], ["DELETE", "/notes/old"],
    ]) {
      const response = await server.app.request(path, { method, headers, ...(method === "GET" ? {} : { body: "malformed" }) });
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(await response.json()).toMatchObject({ code: "notes_moved", error: expect.stringContaining("更新") });
    }
    expect(readFileSync(body, "utf8")).toBe("historical Markdown");
    expect(openLegacyNotes).not.toHaveBeenCalled();
  } finally {
    await server.close();
    openLegacyNotes.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
