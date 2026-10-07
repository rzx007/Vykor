import { describe, expect, it } from "vitest";

import { atomicWrite } from "./atomic-write.js";
import type { StorageContext } from "./storage-context.js";

describe("atomicWrite", () => {
  it("returns the result and saves only after atomic has completed", () => {
    const order: string[] = [];
    let inTransaction = false;
    const storage = {
      atomic<T>(work: () => T): T {
        order.push("begin");
        inTransaction = true;
        const value = work();
        inTransaction = false;
        order.push("commit");
        return value;
      },
    } as StorageContext;
    const value = { result: 42 };

    const result = atomicWrite(storage, () => {
      expect(inTransaction).toBe(true);
      order.push("work");
      return value;
    }, () => {
      expect(inTransaction).toBe(false);
      order.push("save");
    });

    expect(result).toBe(value);
    expect(order).toEqual(["begin", "work", "commit", "save"]);
  });

  it("propagates a work failure without saving", () => {
    let saved = false;
    const failure = new Error("Work failed");
    const storage = { atomic<T>(work: () => T): T { return work(); } } as StorageContext;

    expect(() => atomicWrite(storage, () => { throw failure; }, () => { saved = true; })).toThrow(failure);
    expect(saved).toBe(false);
  });

  it("does not save when atomic fails after work returns", () => {
    let saved = false;
    const failure = new Error("Commit failed");
    const storage = {
      atomic<T>(work: () => T): T { work(); throw failure; },
    } as StorageContext;

    expect(() => atomicWrite(storage, () => 42, () => { saved = true; })).toThrow(failure);
    expect(saved).toBe(false);
  });

  it("allows an omitted save callback", () => {
    const storage = { atomic<T>(work: () => T): T { return work(); } } as StorageContext;

    expect(atomicWrite(storage, () => 42)).toBe(42);
  });

  it("propagates a save failure after the committed work", () => {
    let committed = false;
    const failure = new Error("Save failed");
    const storage = {
      atomic<T>(work: () => T): T {
        const value = work();
        committed = true;
        return value;
      },
    } as StorageContext;

    expect(() => atomicWrite(storage, () => 42, () => { throw failure; })).toThrow(failure);
    expect(committed).toBe(true);
  });
});
