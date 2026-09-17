import { describe, expect, it, vi } from "vitest";

import { AttachmentStorageOperationGate } from "../attachment-storage-operation-gate.js";

describe("AttachmentStorageOperationGate", () => {
  it("waits for active imports before maintenance and blocks later imports behind it", async () => {
    const gate = new AttachmentStorageOperationGate();
    const releaseFirst = deferred();
    const releaseMaintenance = deferred();
    const order: string[] = [];

    const firstImport = gate.runShared(async () => {
      order.push("first-import-start");
      await releaseFirst.promise;
      order.push("first-import-end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-import-start"]));

    const maintenance = gate.runExclusive(async () => {
      order.push("maintenance-start");
      await releaseMaintenance.promise;
      order.push("maintenance-end");
    });
    const laterImport = gate.runShared(async () => {
      order.push("later-import");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-import-start"]);

    releaseFirst.resolve();
    await vi.waitFor(() => expect(order).toContain("maintenance-start"));
    expect(order).not.toContain("later-import");

    releaseMaintenance.resolve();
    await Promise.all([firstImport, maintenance, laterImport]);
    expect(order).toEqual([
      "first-import-start",
      "first-import-end",
      "maintenance-start",
      "maintenance-end",
      "later-import",
    ]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
