import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { StorageContext } from "../database/storage-context.js";
import { SessionStore } from "../session-runtime/store.js";

function fixture(work: (store: SessionStore, storage: StorageContext, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-permission-rollback-"));
  const path = join(directory, "store.db");
  const store = new SessionStore({ path });
  try {
    store.sessions.create({ id: "s1", cwd: directory, model: "m" });
    const payload = { command: "echo accepted", nested: { value: "original" } };
    for (const id of ["q1", "q2"]) {
      store.permissions.create({ id, sessionId: "s1", toolName: "bash", payload });
    }
    work(store, (store as unknown as { storage: StorageContext }).storage, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("permission payload isolation", () => {
  it("restores both requests sharing an input payload after a reply transaction aborts", () => {
    fixture((store, storage, path) => {
      const before = store.permissions.list();
      const events = structuredClone(storage.state.events);

      expect(() => store.transaction(() => {
        store.permissions.reply({ requestId: "q1", status: "approved", answer: { value: "rejected" } });
        throw new Error("abort reply");
      })).toThrow("abort reply");

      expect.soft(store.permissions.get("q1")).toEqual(before.find(({ id }) => id === "q1"));
      expect.soft(store.permissions.get("q2")).toEqual(before.find(({ id }) => id === "q2"));
      expect.soft(storage.state.events).toEqual(events);
      expect.soft(store.conversations.listEvents()).toEqual(events);

      const reopened = new SessionStore({ path });
      try {
        expect.soft(reopened.permissions.list()).toEqual(before);
        expect.soft(reopened.conversations.listEvents()).toEqual(events);
      } finally { reopened.close(); }
    });
  });

  it("updates only the replied request and preserves asked events when payload input is shared", () => {
    fixture((store, storage, path) => {
      const other = store.permissions.get("q2");
      const asked = structuredClone(storage.state.events.filter(({ type }) => type === "permission.asked"));

      const replied = store.permissions.reply({ requestId: "q1", status: "approved", answer: { value: "accepted" } });

      expect(replied).toMatchObject({ id: "q1", status: "approved", payload: {
        command: "echo accepted", nested: { value: "original" }, answer: { value: "accepted" },
      } });
      expect.soft(store.permissions.get("q2")).toEqual(other);
      expect.soft(storage.state.events.filter(({ type }) => type === "permission.asked")).toEqual(asked);

      const reopened = new SessionStore({ path });
      try {
        expect.soft(reopened.permissions.get("q1")).toEqual(replied);
        expect.soft(reopened.permissions.get("q2")).toEqual(other);
        expect.soft(reopened.conversations.listEvents().filter(({ type }) => type === "permission.asked")).toEqual(asked);
      } finally { reopened.close(); }
    });
  });
});
