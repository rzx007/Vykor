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
      const dir = mkdtempSync(join(tmpdir(), "ohs-tx-coord-hook-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });

      try {
        // Initial setup
        const s1 = store.createSession({ id: "s1", cwd: dir, model: "m" });
        const m1 = store.createMessage({ id: "m1", sessionId: "s1", role: "user" });
        const p1 = store.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: "m1",
          type: "text",
          text: "hello",
        });

        const initialSessionUpdatedAt = store.getSession("s1")!.updatedAt;
        const initialEventCount = store.listEvents({ sessionId: "s1" }).length;
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
            store.updateSession("s1", { title: "New Title" });

            // 2. Append event
            store.appendEvent({
              type: "session.updated",
              sessionId: "s1",
              payload: { session: store.getSession("s1")! },
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
        const inMemorySession = store.getSession("s1")!;
        expect(inMemorySession.title).toBe("");
        expect(inMemorySession.updatedAt).toBe(initialSessionUpdatedAt);

        // Assert 3: In-memory events rolled back
        expect(store.listEvents({ sessionId: "s1" }).length).toBe(initialEventCount);

        // Assert 4: In-memory dirty parts rolled back
        expect((store as any).deltaCheckpoint.dirtyPartIds()).toEqual([]);

        // Assert 5: Close store and reopen from SQLite to verify disk consistency
        store.close();
        store = new SessionStore({ path: dbPath });

        const reloadedSession = store.getSession("s1")!;
        expect(reloadedSession.title).toBe("");
        expect(reloadedSession.updatedAt).toBe(initialSessionUpdatedAt);
        expect(store.listEvents({ sessionId: "s1" }).length).toBe(initialEventCount);
        expect(store.listMessageParts("s1")[0]?.text).toBe(initialPartText);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("handles nested atomic calls and only commits on the outermost transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-tx-nested-"));
    const dbPath = join(dir, "store.db");
    const store = new SessionStore({ path: dbPath });

    try {
      store.createSession({ id: "s1", cwd: dir, model: "m" });
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
          store.updateSession("s1", { title: "Nested Title" });
          coordinator.deferUntilCommit(() => {
            deferredOrders.push("inner");
          });
        });

        // Nested commit hasn't flushed yet
        expect(deferredOrders).toEqual([]);
      });

      // Outermost commit flushed all deferred callbacks in order
      expect(deferredOrders).toEqual(["outer", "inner"]);
      expect(store.getSession("s1")!.title).toBe("Nested Title");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
