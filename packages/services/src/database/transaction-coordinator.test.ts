import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import {
  TransactionCoordinator,
  type TransactionCoordinatorHooks,
} from "./transaction-coordinator.js";

describe("TransactionCoordinator rollback & hook contracts", () => {
  it.each(["beforeFlush", "afterMutationSql", "beforeCommit"] as const)(
    "rolls back in-memory state, SQLite data, dirty parts, and suppresses deferred commit callbacks when %s throws",
    (hookName) => {
      const dir = mkdtempSync(join(tmpdir(), "vk-tx-coord-hook-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });

      try {
        // Initial setup
        const s1 = store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const m1 = store.conversations.createMessage({ id: "m1", sessionId: "s1", role: "user" });
        const p1 = store.conversations.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: "m1",
          type: "text",
          text: "hello",
        });

        const initialSessionUpdatedAt = store.sessions.get("s1")!.updatedAt;
        const initialEventCount = store.conversations.listEvents({ sessionId: "s1" }).length;
        const initialPartText = p1.text;

        const hooks: TransactionCoordinatorHooks = {
          [hookName]: () => {
            throw new Error(`Simulated failure in ${hookName}`);
          },
        };

        const coordinator = new TransactionCoordinator({
          storage: (store as any).storage,
          persistChanges: () => (store as any).persistChanges(),
          hooks,
        });

        let deferredCalled = false;

        expect(() =>
          coordinator.atomic(() => {
            // 1. Modify session
            store.sessions.update("s1", { title: "New Title" });

            // 2. Append event
            store.conversations.appendEvent({
              type: "session.updated",
              sessionId: "s1",
              payload: { session: store.sessions.get("s1")! },
            });

            // 3. Mark part dirty
            (store as any).deltaCheckpoint.markDirty("p1", 100);

            // 4. Register deferred commit callback
            coordinator.deferUntilCommit(() => {
              deferredCalled = true;
            });
          }),
        ).toThrow(`Simulated failure in ${hookName}`);

        // Assert 1: In-memory deferred callback was NOT executed
        expect(deferredCalled).toBe(false);

        // Assert 2: In-memory session state rolled back
        const inMemorySession = store.sessions.get("s1")!;
        expect(inMemorySession.title).toBe("");
        expect(inMemorySession.updatedAt).toBe(initialSessionUpdatedAt);

        // Assert 3: In-memory events rolled back
        expect(store.conversations.listEvents({ sessionId: "s1" }).length).toBe(initialEventCount);

        // Assert 4: In-memory dirty parts rolled back
        expect((store as any).deltaCheckpoint.dirtyPartIds()).toEqual([]);

        // Assert 5: Close store and reopen from SQLite to verify disk consistency
        store.close();
        store = new SessionStore({ path: dbPath });

        const reloadedSession = store.sessions.get("s1")!;
        expect(reloadedSession.title).toBe("");
        expect(reloadedSession.updatedAt).toBe(initialSessionUpdatedAt);
        expect(store.conversations.listEvents({ sessionId: "s1" }).length).toBe(initialEventCount);
        expect(store.conversations.listMessageParts("s1")[0]?.text).toBe(initialPartText);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("handles nested atomic calls and only commits on the outermost transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-tx-nested-"));
    const dbPath = join(dir, "store.db");
    const store = new SessionStore({ path: dbPath });

    try {
      store.sessions.create({ id: "s1", cwd: dir, model: "m" });
      const coordinator = new TransactionCoordinator({
        storage: (store as any).storage,
        persistChanges: () => (store as any).persistChanges(),
      });

      const deferredOrders: string[] = [];

      coordinator.atomic(() => {
        coordinator.deferUntilCommit(() => {
          deferredOrders.push("outer");
        });

        coordinator.atomic(() => {
          store.sessions.update("s1", { title: "Nested Title" });
          coordinator.deferUntilCommit(() => {
            deferredOrders.push("inner");
          });
        });

        // Nested commit hasn't flushed yet
        expect(deferredOrders).toEqual([]);
      });

      // Outermost commit flushed all deferred callbacks in order
      expect(deferredOrders).toEqual(["outer", "inner"]);
      expect(store.sessions.get("s1")!.title).toBe("Nested Title");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps committed memory and SQLite state when an after-commit callback throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-tx-callback-error-"));
    const dbPath = join(dir, "store.db");
    let store = new SessionStore({ path: dbPath });

    try {
      store.sessions.create({ id: "s1", cwd: dir, model: "m" });
      const coordinator = new TransactionCoordinator({
        storage: (store as any).storage,
        persistChanges: () => (store as any).persistChanges(),
      });

      expect(() =>
        coordinator.atomic(() => {
          store.sessions.update("s1", { title: "Committed Title" });
          coordinator.deferUntilCommit(() => {
            throw new Error("after commit failed");
          });
        }),
      ).toThrow("after commit failed");

      expect(store.sessions.get("s1")?.title).toBe("Committed Title");
      store.close();
      store = new SessionStore({ path: dbPath });
      expect(store.sessions.get("s1")?.title).toBe("Committed Title");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows an outer transaction to continue after a caught nested validation error", () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-tx-nested-caught-"));
    const dbPath = join(dir, "store.db");
    let store = new SessionStore({ path: dbPath });

    try {
      store.sessions.create({ id: "s1", cwd: dir, model: "m" });
      const coordinator = new TransactionCoordinator({
        storage: (store as any).storage,
        persistChanges: () => (store as any).persistChanges(),
      });

      expect(() =>
        coordinator.atomic(() => {
          store.sessions.update("s1", { title: "Outer Change" });
          try {
            coordinator.atomic(() => {
              throw new Error("nested failed");
            });
          } catch {
            // Existing callers intentionally recover from validation failures.
          }
        }),
      ).not.toThrow();

      expect(store.sessions.get("s1")?.title).toBe("Outer Change");
      store.close();
      store = new SessionStore({ path: dbPath });
      expect(store.sessions.get("s1")?.title).toBe("Outer Change");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
