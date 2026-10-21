import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notes } from "../src/notes.mjs";
test("manual save, model selection, conflict, durable operation dedup", () => {
  const root = mkdtempSync(join(tmpdir(), "notes-business-"));
  try {
    const file = join(root, "note.json"), notes = new Notes(file);
    const request = { operationId: "manual-1", expectedRevision: 0, text: "Hello world" };
    assert.equal(notes.write(request, "save").revision, 1);
    const restart = new Notes(file);
    assert.equal(restart.write(request, "save").duplicate, true);
    assert.throws(() => restart.write({ ...request, text: "different" }, "save"), /operation_id_conflict/);
    assert.throws(() => restart.write({ ...request, operationId: "stale" }, "save"), /revision_conflict/);
    assert.equal(restart.write({ expectedRevision: 1, operationId: "model-1", start: 6, end: 11, text: "team" }, "replace").text, "Hello team");
    assert.equal(new Notes(file).read().revision, 2);
    assert.throws(() => restart.write({ expectedRevision: 2, operationId: "bad", start: -1, end: 100, text: "x" }, "replace"), /invalid_selection/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
