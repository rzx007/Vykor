import { describe, expect, it } from "vitest";

import { TransactionJournal } from "./transaction-journal.js";

describe("TransactionJournal", () => {
  it("restores the first deep copy after repeated changes to one key", () => {
    const rows = { one: { nested: { value: 1 } } };
    const original = rows.one;
    const journal = new TransactionJournal();

    journal.capture(rows, "one");
    rows.one.nested.value = 2;
    journal.capture(rows, "one");
    rows.one.nested.value = 3;
    journal.rollback();

    expect(rows.one).toEqual({ nested: { value: 1 } });
    expect(rows.one).not.toBe(original);
  });

  it("does not read a captured property again or visit unrelated properties", () => {
    let reads = 0;
    const rows = {
      get one() {
        reads += 1;
        return { value: 1 };
      },
      get unrelated() {
        throw new Error("Unrelated record must not be read");
      },
    };
    const journal = new TransactionJournal();

    journal.capture(rows, "one");
    journal.capture(rows, "one");

    expect(reads).toBe(1);
    expect(journal.previous(rows, "one")).toEqual({ value: 1 });
  });

  it("captures the same key independently on different targets", () => {
    const first = { value: 1 };
    const second = { value: 2 };
    const journal = new TransactionJournal();
    journal.capture(first, "value");
    journal.capture(second, "value");
    first.value = 3;
    second.value = 4;

    journal.rollback();

    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
  });

  it("deletes new keys and restores own keys whose value was undefined", () => {
    const rows: Record<string, number | undefined> = { present: undefined };
    const journal = new TransactionJournal();
    journal.capture(rows, "new");
    journal.capture(rows, "present");
    rows.new = 1;
    rows.present = 2;

    journal.rollback();

    expect(Object.hasOwn(rows, "new")).toBe(false);
    expect(Object.hasOwn(rows, "present")).toBe(true);
    expect(rows.present).toBeUndefined();
  });

  it("restores an inherited value by removing a newly added own key", () => {
    const rows: { value: number } = Object.create({ value: 1 });
    const journal = new TransactionJournal();
    journal.capture(rows, "value");
    rows.value = 2;

    journal.rollback();

    expect(Object.hasOwn(rows, "value")).toBe(false);
    expect(rows.value).toBe(1);
  });

  it("restores the original record after deletion and recreation", () => {
    const rows: Record<string, { value: number }> = { one: { value: 1 } };
    const journal = new TransactionJournal();
    journal.capture(rows, "one");
    delete rows.one;
    journal.capture(rows, "one");
    rows.one = { value: 2 };

    journal.rollback();

    expect(rows.one).toEqual({ value: 1 });
  });

  it("treats numeric and string forms as the same object key", () => {
    const rows: Record<string | number, { value: number }> = { 1: { value: 1 } };
    const journal = new TransactionJournal();
    journal.capture(rows, 1);
    rows[1]!.value = 2;
    journal.capture(rows, "1");

    expect(journal.previous(rows, "1")).toEqual({ value: 1 });
    journal.rollback();
    expect(rows[1]).toEqual({ value: 1 });
  });

  it("restores symbol keys", () => {
    const key = Symbol("row");
    const rows = { [key]: { value: 1 } };
    const journal = new TransactionJournal();
    journal.capture(rows, key);
    rows[key].value = 2;

    journal.rollback();

    expect(rows[key]).toEqual({ value: 1 });
  });

  it("restores Map values after replacement and deletion with object key identity", () => {
    const key = {};
    const original = { nested: { value: 1 } };
    const rows = new Map([[key, original]]);
    const journal = new TransactionJournal();
    journal.captureMap(rows, key);
    original.nested.value = 2;
    journal.captureMap(rows, key);
    rows.delete(key);
    rows.set(key, { nested: { value: 3 } });
    const newKey = {};
    journal.captureMap(rows, newKey);
    rows.set(newKey, { nested: { value: 4 } });

    journal.rollback();

    expect(rows.get(key)).toEqual({ nested: { value: 1 } });
    expect(rows.get(key)).not.toBe(original);
    expect(rows.has(newKey)).toBe(false);
  });

  it("distinguishes a missing Map entry from an entry holding undefined", () => {
    const rows = new Map<string, number | undefined>([["present", undefined]]);
    const journal = new TransactionJournal();
    journal.captureMap(rows, "present");
    journal.captureMap(rows, "missing");
    rows.delete("present");
    rows.set("missing", 1);

    journal.rollback();

    expect(rows.has("present")).toBe(true);
    expect(rows.get("present")).toBeUndefined();
    expect(rows.has("missing")).toBe(false);
  });

  it("removes appended events without cloning retained events", () => {
    const event = { value: 1, nonCloneable: () => undefined };
    const events = [event];
    const owner = { events };
    const journal = new TransactionJournal();
    journal.captureEvents(owner);
    owner.events.push({ value: 2, nonCloneable: () => undefined });
    journal.captureEvents(owner);
    owner.events.push({ value: 3, nonCloneable: () => undefined });

    journal.rollback();

    expect(owner.events).toBe(events);
    expect(owner.events).toHaveLength(1);
    expect(owner.events[0]).toBe(event);
  });

  it("restores the original event array after append and filter replacement", () => {
    const first = { id: "first" };
    const second = { id: "second" };
    const events = [first, second];
    const owner = { events };
    const journal = new TransactionJournal();
    journal.captureEvents(owner);
    owner.events.push({ id: "new" });
    owner.events = owner.events.filter((event) => event.id !== "first");
    journal.captureEvents(owner);
    owner.events.push({ id: "later" });

    journal.rollback();

    expect(owner.events).toBe(events);
    expect(owner.events).toEqual([{ id: "first" }, { id: "second" }]);
    expect(owner.events[0]).toBe(first);
    expect(owner.events[1]).toBe(second);
  });

  it("returns only captured previous values and discards backups on clear", () => {
    const rows: Record<string, { value: number }> = { one: { value: 1 } };
    const events = [{ value: 1 }];
    const owner = { events };
    const map = new Map([["one", { value: 1 }]]);
    const journal = new TransactionJournal();
    expect(journal.previous(rows, "one")).toBeUndefined();
    journal.capture(rows, "one");
    journal.capture(rows, "missing");
    journal.captureMap(map, "one");
    journal.captureEvents(owner);
    delete rows.one;
    map.set("one", { value: 2 });
    owner.events.push({ value: 2 });
    expect(journal.previous(rows, "one")).toEqual({ value: 1 });
    expect(journal.previous(rows, "missing")).toBeUndefined();

    journal.clear();
    journal.rollback();

    expect(journal.previous(rows, "one")).toBeUndefined();
    expect(Object.hasOwn(rows, "one")).toBe(false);
    expect(map.get("one")).toEqual({ value: 2 });
    expect(owner.events).toHaveLength(2);
    rows.one = { value: 3 };
    journal.capture(rows, "one");
    rows.one.value = 4;
    journal.rollback();
    expect(rows.one).toEqual({ value: 3 });
  });

  it("restores in reverse order and aggregates failures after trying every key", () => {
    const order: string[] = [];
    const failure = new Error("Blocked write");
    let first = 1;
    let last = 3;
    const rows = {
      get first() { return first; },
      set first(value: number) { order.push("first"); first = value; },
      get blocked() { return 2; },
      set blocked(_value: number) { order.push("blocked"); throw failure; },
      get last() { return last; },
      set last(value: number) { order.push("last"); last = value; },
    };
    const journal = new TransactionJournal();
    journal.capture(rows, "first");
    journal.capture(rows, "blocked");
    journal.capture(rows, "last");
    first = 10;
    last = 30;

    let caught: unknown;
    try { journal.rollback(); } catch (error) { caught = error; }

    expect(order).toEqual(["last", "blocked", "first"]);
    expect(first).toBe(1);
    expect(last).toBe(3);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure]);
  });
});
