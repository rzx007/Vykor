import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDurableEventRegistry,
  defaultDurableEventRegistry,
  DurableEventRegistryError,
  type DurableEventDefinition,
} from "../event-registry.js";
import { SessionStore } from "../store.js";

const versionedFixture: DurableEventDefinition = {
  type: "fixture.title.changed",
  currentVersion: 2,
  scope: "session",
  validate(payload) {
    if (typeof payload.title !== "string") throw new Error("title must be a string");
  },
};

describe("DurableEventRegistry", () => {
  it("rejects unregistered event types instead of accepting typos", () => {
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.mesage.created",
      { message: {} },
      "s1",
    )).toThrowError(expect.objectContaining<Partial<DurableEventRegistryError>>({
      code: "unknown_type",
      eventType: "session.mesage.created",
    }));
  });

  it("rejects missing fields, wrong field types, and invalid scope", () => {
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.run.error",
      { runId: "r1" },
      "s1",
    )).toThrow("error must be a string");
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.run.error",
      { runId: 42, error: "failed" },
      "s1",
    )).toThrow("runId must be a string");
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.run.error",
      { runId: "r1", error: "failed" },
    )).toThrow("requires a sessionId");
  });

  it("requires a non-empty list of session IDs in a global deletion event", () => {
    expect(() => defaultDurableEventRegistry.prepareWrite("session.deleted", { sessionIds: [] }))
      .toThrow("sessionIds must be a non-empty string array");
    expect(() => defaultDurableEventRegistry.prepareWrite("session.deleted", { sessionIds: ["s1", 4] }))
      .toThrow("sessionIds must be a non-empty string array");
  });

  it("accepts only the current event version", () => {
    const registry = createDurableEventRegistry([versionedFixture]);
    expect(registry.prepareRead(
      versionedFixture.type,
      2,
      { title: "New title" },
      "s1",
    )).toEqual({
      type: versionedFixture.type,
      schemaVersion: 2,
      payload: { title: "New title" },
    });
    expect(() => registry.prepareRead(
      versionedFixture.type,
      1,
      { title: "Old title" },
      "s1",
    )).toThrowError(expect.objectContaining<Partial<DurableEventRegistryError>>({
      code: "unsupported_version",
      schemaVersion: 1,
    }));
    expect(() => registry.prepareRead(
      versionedFixture.type,
      3,
      { title: "Future title" },
      "s1",
    )).toThrowError(expect.objectContaining<Partial<DurableEventRegistryError>>({
      code: "unsupported_version",
      schemaVersion: 3,
    }));
  });

  it("writes structured input admissions as v2 and rejects v1 replays", () => {
    const payload = { input: {} };
    expect(defaultDurableEventRegistry.prepareWrite(
      "session.input.admitted",
      payload,
      "s1",
    )).toMatchObject({ schemaVersion: 2, payload });
    expect(() => defaultDurableEventRegistry.prepareRead(
      "session.input.admitted",
      1,
      payload,
      "s1",
    )).toThrowError(expect.objectContaining<Partial<DurableEventRegistryError>>({
      code: "unsupported_version",
      schemaVersion: 1,
    }));
  });

  it("rejects unregistered event names at both read and write boundaries", () => {
    expect(() => defaultDurableEventRegistry.prepareRead(
      "provider.rate_limited",
      1,
      { frameworkEventId: "framework-1", retryAfterMs: 1_000 },
      "s1",
    )).toThrow("Unregistered durable event type");
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "provider.rate_limited",
      { frameworkEventId: "framework-1", retryAfterMs: 1_000 },
      "s1",
    )).toThrow("Unregistered durable event type");
  });

  it("makes the store enforce the registry before allocating a cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-event-registry-write-"));
    const path = join(dir, "store.db");
    try {
      const store = new SessionStore({ path });
      store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const cursor = store.conversations.latestEventSeq();
      expect(() => store.conversations.appendEvent({
        type: "session.run.error",
        sessionId: "s1",
        payload: { runId: "r1", error: 42 },
      })).toThrow("error must be a string");
      expect(store.conversations.latestEventSeq()).toBe(cursor);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
