import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { StorageContext } from "../database/storage-context.js";
import { SessionStore } from "./store.js";

function withStore(test: (store: SessionStore, storage: StorageContext, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vykor-store-save-"));
  const path = join(directory, "store.db");
  const store = new SessionStore({ path, deltaFlushIntervalMs: 60_000 });
  const storage = (store as unknown as { storage: StorageContext }).storage;
  try {
    store.sessions.create({ id: "session", cwd: directory, model: "m" });
    test(store, storage, path);
  } finally {
    storage.coordinator?.setHooks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SessionStore saves", () => {
  it.each(["session", "run"] as const)("persists a standalone %s update with only one full-state backup", (kind) => {
    withStore((store, storage, path) => {
      store.runs.createRun({ id: "run", sessionId: "session" });
      const clone = vi.spyOn(globalThis, "structuredClone");
      try {
        if (kind === "session") store.sessions.update("session", { title: "updated title" });
        else store.runs.updateRun("run", { status: "running" });
        expect(clone.mock.calls.filter(([value]) => value === storage.state)).toHaveLength(1);
      } finally {
        clone.mockRestore();
      }

      const reopened = new SessionStore({ path });
      try {
        if (kind === "session") expect(reopened.sessions.get("session")?.title).toBe("updated title");
        else expect(reopened.runs.getRun("run")?.status).toBe("running");
      } finally {
        reopened.close();
      }
    });
  });

  it("persists pending text produced after commit even when no ordinary records remain dirty", () => {
    withStore((store, storage) => {
      store.conversations.createMessage({ id: "message", sessionId: "session", role: "assistant" });
      store.conversations.upsertMessagePart({ id: "part", sessionId: "session", messageId: "message", type: "text", text: "" });
      let appendAfterCommit = true;
      storage.coordinator!.setHooks({ beforeCommit() {
        if (!appendAfterCommit) return;
        appendAfterCommit = false;
        storage.coordinator!.deferUntilCommit(() => {
          store.incrementalOutput.appendMessagePartDelta({
            sessionId: "session", messageId: "message", partId: "part", field: "text", delta: "accepted after commit",
          });
        });
      } });

      store.sessions.update("session", { title: "updated title" });

      expect(storage.database.connection.prepare("SELECT text FROM session_message_part WHERE id = 'part'").get())
        .toEqual({ text: "accepted after commit" });
      expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual([]);
      expect(store.conversations.listMessageParts("session")[0]?.text).toBe("accepted after commit");
    });
  });

  it("checks the owner fence even when the second save has nothing left to write", () => {
    withStore((store, storage) => {
      store.acquireApplicationOwner({ ownerId: "owner-1", pid: process.pid, staleAfterMs: 60_000 });
      let takeOverAfterCommit = true;
      storage.coordinator!.setHooks({ beforeCommit() {
        if (!takeOverAfterCommit) return;
        takeOverAfterCommit = false;
        storage.coordinator!.deferUntilCommit(() => {
          storage.database.connection.prepare("UPDATE application_owner SET owner_id = 'owner-2', generation = generation + 1 WHERE key = 'application'").run();
        });
      } });

      expect(() => store.sessions.update("session", { title: "updated title" }))
        .toThrow("Data directory is already owned by owner-2");
    });
  });
});
