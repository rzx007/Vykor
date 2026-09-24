import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultDurableEventRegistry } from "../session-runtime/event-registry.js";
import { SessionStore } from "../session-runtime/store.js";
import { loadSessionReadModel } from "./read-model.js";
import { SessionDatabase } from "./session-database.js";

describe("loadSessionReadModel", () => {
  it("rehydrates the canonical session graph and event cursor", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-read-model-"));
    const path = join(directory, "sessions.db");
    try {
      const store = new SessionStore({ path });
      store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.conversationTransactions.admitPrompt({
        id: "i1",
        sessionId: "s1",
        content: "hello",
      });
      store.runs.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
      store.close();

      const database = SessionDatabase.open({ path });
      try {
        const loaded = loadSessionReadModel(
          database.connection,
          defaultDurableEventRegistry,
        );
        expect(Object.keys(loaded.state.sessions)).toEqual(["s1"]);
        expect(Object.keys(loaded.state.inputs)).toEqual(["i1"]);
        expect(Object.keys(loaded.state.runs)).toEqual(["r1"]);
        expect(loaded.state.events.map((event) => event.type)).toEqual([
          "session.created",
          "session.input.admitted",
          "session.run.created",
        ]);
        expect(loaded.reservedEventSeq).toBe(1024);
        expect(loaded.state.nextEventSeq).toBe(1025);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
