import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";

import * as gitAssembly from "../auto-review/git-run-change-inspector.js";
import {
  bindContextUsageLiveAssembler,
  getBoundContextUsageLiveAssembler,
  type ContextUsageLiveAssembler,
} from "../context-usage/context-usage-live-binder.js";
import { createDefaultNodeApplication } from "../default-node-application.js";
import type { DaemonApplication } from "../daemon-application.js";

const settings = { model: "test" } as Settings;
const directories: string[] = [];
const stores: SessionStore[] = [];
const applications: DaemonApplication[] = [];
const releases: Array<() => void> = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-context-binding-"));
  directories.push(directory);
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  stores.push(store);
  return store;
}

function createApplication() {
  const application = createDefaultNodeApplication({ store: createStore(), settings, log: () => {} });
  applications.push(application);
  return application;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const application of applications.splice(0)) await application.close().catch(() => {});
  for (const release of releases.splice(0)) {
    if (typeof release === "function") release();
  }
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DaemonApplication context usage binding lifetime", () => {
  it.each([false, true])("releases its real binding after synchronous assembly failure (ownsStore=%s)", (ownsStore) => {
    const store = createStore();
    const constructionError = new Error("git inspector assembly failed after live binding");
    let boundDuringAssembly: ContextUsageLiveAssembler | undefined;
    // This factory runs immediately after the real live assembler was bound.
    vi.spyOn(gitAssembly, "createGitRunChangeInspector").mockImplementationOnce(() => {
      boundDuringAssembly = getBoundContextUsageLiveAssembler();
      throw constructionError;
    });

    let failure: unknown;
    try {
      createDefaultNodeApplication({ store, ownsStore, settings, log: () => {} });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(constructionError);
    expect(boundDuringAssembly).toBeTypeOf("function");
    expect(getBoundContextUsageLiveAssembler()).toBeUndefined();
    if (ownsStore) {
      expect(() => store.listRetentionAudits()).toThrow();
    } else {
      expect(store.listRetentionAudits()).toEqual([]);
      const lease = store.acquireApplicationOwner({
        ownerId: "replacement", pid: process.pid, staleAfterMs: 30_000, canTakeOver: () => false,
      });
      store.releaseApplicationOwner(lease);
    }
  });

  it("releases its current binding when normal close starts and allows repeated close", async () => {
    const application = createApplication();
    await application.ready();
    expect(getBoundContextUsageLiveAssembler()).toBeTypeOf("function");

    const closing = application.close();
    expect(getBoundContextUsageLiveAssembler()).toBeUndefined();
    expect(application.close()).toBe(closing);
    await closing;
    await application.close();
    expect(getBoundContextUsageLiveAssembler()).toBeUndefined();
  });

  it("keeps a newer binding when an older application closes", async () => {
    const application = createApplication();
    await application.ready();
    const newerAssembler: ContextUsageLiveAssembler = async () => null;
    releases.push(bindContextUsageLiveAssembler(newerAssembler));

    await application.close();
    await application.close();
    expect(getBoundContextUsageLiveAssembler()).toBe(newerAssembler);
  });
});
