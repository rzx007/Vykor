import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DeltaCheckpoint } from "../database/delta-checkpoint.js";
import { DurableEventSequence } from "../database/event-sequence.js";
import { createMutationBuffer } from "../database/mutation-buffer.js";
import { SessionDatabase } from "../database/session-database.js";
import type { StorageContext } from "../database/storage-context.js";
import { sessionMessageParts } from "./schema.js";
import { persistSessionChanges } from "./store-persistence.js";
import { emptyState } from "./store-state.js";

describe("persistSessionChanges", () => {
  it.each([100, 1000])("reuses query preparation when upserting %i dirty parts", (partCount) => {
    const dir = mkdtempSync(join(tmpdir(), "vk-persist-batch-"));
    const database = SessionDatabase.open({ path: join(dir, "store.db") });
    const state = emptyState();
    const storage: StorageContext = {
      database,
      state,
      mutations: createMutationBuffer(),
      eventSequence: DurableEventSequence.load(database.orm, state),
      deltaCheckpoint: new DeltaCheckpoint({ intervalMs: 100, bytes: 100, flush: () => {} }),
      atomic: (work) => database.connection.transaction(work)(),
      assertWritable: () => {},
    };
    const output = { flushMessagePartDeltas: () => {} };
    try {
      state.parts["part-0"] = {
        id: "part-0", sessionId: "session", messageId: "message", seq: 1,
        type: "tool", status: "running", text: "old", input: { old: true },
        output: "old", isError: true, metadata: { old: true }, createdAt: 1, updatedAt: 2,
      };
      storage.mutations.parts.add("part-0");
      storage.atomic(() => persistSessionChanges(storage, output));

      for (let index = 0; index < partCount; index++) {
        const id = `part-${index}`;
        state.parts[id] = {
          id, sessionId: "session", messageId: "message", seq: index + 1,
          type: "tool", status: "completed", text: index === 0 ? undefined : `text-${index}`,
          input: index === 0 ? undefined : { index },
          output: index === 0 ? null : { result: index }, isError: false,
          metadata: { batch: true }, createdAt: 3, updatedAt: 4,
        };
        storage.mutations.parts.add(id);
      }

      // Observe real SQLite work: rebuilding/preparing once per row causes the regression.
      const prepare = vi.spyOn(database.connection, "prepare");
      let preparationCount: number;
      try {
        storage.atomic(() => persistSessionChanges(storage, output));
        preparationCount = prepare.mock.calls.length;
      } finally {
        prepare.mockRestore();
      }

      const rows = database.orm.select().from(sessionMessageParts)
        .orderBy(sessionMessageParts.seq).all();
      expect(rows).toHaveLength(partCount);
      expect(rows[0]).toMatchObject({
        id: "part-0", text: null, inputJson: null, outputJson: "null", isError: 0,
        toolUseId: null, toolName: null, assetId: null, metadataJson: '{"batch":true}',
        createdAt: 3, updatedAt: 4,
      });
      expect(rows[1]).toMatchObject({
        id: "part-1", text: "text-1", inputJson: '{"index":1}',
        outputJson: '{"result":1}', isError: 0,
      });
      expect(preparationCount).toBeLessThanOrEqual(1);
    } finally {
      storage.deltaCheckpoint.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
