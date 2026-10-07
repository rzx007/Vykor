import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { StorageContext } from "../database/storage-context.js";
import { SessionStore } from "../session-runtime/store.js";

function fixture(
  mode: "sqlite" | "memory",
  work: (
    store: SessionStore,
    storage: StorageContext,
    binding: { id: string; path: string; branch: string },
  ) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-worktree-rollback-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  const storage = (store as unknown as { storage: StorageContext }).storage;
  const binding = {
    id: "worktree-id",
    path: join(directory, "removed-worktree"),
    branch: "vykor/result",
  };
  try {
    store.sessions.create({
      id: "session",
      cwd: directory,
      model: "m",
      storage: mode,
      metadata: {
        desktop: { worktree: binding, retained: "yes" },
        retainedRoot: true,
      },
    });
    store.sessions.archive("session");
    work(store, storage, binding);
  } finally {
    storage.coordinator!.setHooks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function snapshot(store: SessionStore, storage: StorageContext) {
  return {
    session: store.sessions.get("session"),
    events: store.conversations.listEvents({ sessionId: "session" }),
    persisted: storage.database.connection
      .prepare("SELECT * FROM session WHERE id = 'session'")
      .get(),
    temporary: storage.chatPersistence!.snapshot(),
  };
}

describe.each(["sqlite", "memory"] as const)(
  "%s worktree binding transaction boundaries",
  (mode) => {
    it("restores the binding and its update event when commit fails", () => {
      fixture(mode, (store, storage, binding) => {
        const before = snapshot(store, storage);
        storage.coordinator!.setHooks({
          beforeCommit() {
            throw new Error("reject binding clear");
          },
        });
        expect(() =>
          store.sessions.clearWorktreeBinding("session", binding),
        ).toThrow("reject binding clear");
        expect(snapshot(store, storage)).toEqual(before);
      });
    });

    it("restores the binding when later work in the same transaction fails", () => {
      fixture(mode, (store, storage, binding) => {
        const before = snapshot(store, storage);
        expect(() =>
          store.transaction(() => {
            store.sessions.clearWorktreeBinding("session", binding);
            throw new Error("later work failed");
          }),
        ).toThrow("later work failed");
        expect(snapshot(store, storage)).toEqual(before);
      });
    });

    it("rejects owner takeover before changing the binding or history", () => {
      fixture(mode, (store, storage, binding) => {
        const before = snapshot(store, storage);
        store.acquireApplicationOwner({
          ownerId: "first",
          pid: 1,
          staleAfterMs: 1000,
        });
        storage.database.connection
          .prepare(
            "UPDATE application_owner SET owner_id = 'second', generation = generation + 1 WHERE key = 'application'",
          )
          .run();
        expect(() =>
          store.sessions.clearWorktreeBinding("session", binding),
        ).toThrow("Data directory is already owned by second");
        expect(snapshot(store, storage)).toEqual(before);
      });
    });
  },
);
