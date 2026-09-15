import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { emptyState } from "../session-runtime/store-state.js";
import { DurableEventSequence } from "./event-sequence.js";
import { SessionDatabase } from "./session-database.js";

describe("DurableEventSequence", () => {
  it("restores its in-memory cursor from a transaction snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-event-sequence-"));
    const path = join(directory, "sessions.db");
    try {
      const database = SessionDatabase.open({ path });
      const state = emptyState();
      const sequence = DurableEventSequence.load(database.connection, state);
      expect(sequence.allocate()).toBe(1);
      const snapshot = sequence.snapshot();
      expect(sequence.allocate()).toBe(2);

      sequence.restore(snapshot);

      expect(state.nextEventSeq).toBe(2);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not reuse a reserved sequence window after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-event-sequence-restart-"));
    const path = join(directory, "sessions.db");
    try {
      const firstDatabase = SessionDatabase.open({ path });
      const first = DurableEventSequence.load(firstDatabase.connection, emptyState());
      expect(first.allocate()).toBe(1);
      expect(first.snapshot().reservedThrough).toBe(1024);
      firstDatabase.close();

      const secondDatabase = SessionDatabase.open({ path });
      const secondState = emptyState();
      const second = DurableEventSequence.load(
        secondDatabase.connection,
        secondState,
      );
      expect(second.allocate()).toBe(1025);
      expect(secondState.nextEventSeq).toBe(1026);
      secondDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
