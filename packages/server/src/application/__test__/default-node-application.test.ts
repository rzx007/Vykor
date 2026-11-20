import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";

import * as attachmentAssembly from "../attachments/daemon-attachment-services.js";
import { createDefaultNodeApplication, type DefaultNodeApplicationOptions } from "../default-node-application.js";

const settings = { model: "test" } as Settings;
const directories: string[] = [];
const stores = new Set<SessionStore>();

function tempStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "vykor-default-application-"));
  directories.push(directory);
  return join(directory, "sessions.db");
}

function createStore(): SessionStore {
  const store = new SessionStore({ path: tempStorePath() });
  stores.add(store);
  return store;
}

function failAttachmentAssembly(error: Error, inspect?: (store: SessionStore) => void) {
  return vi.spyOn(attachmentAssembly, "createDaemonAttachmentServices")
    .mockImplementationOnce(({ store }) => {
      stores.add(store);
      inspect?.(store);
      throw error;
    });
}

function constructionFailure(options: DefaultNodeApplicationOptions): unknown {
  try {
    createDefaultNodeApplication(options);
  } catch (error) {
    return error;
  }
  throw new Error("Expected synchronous application construction failure");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("default database selection", () => {
  function selectedLegacyStore(source = "registered") {
    const base = mkdtempSync(join(tmpdir(), "vykor-selected-store-"));
    directories.push(base);
    const root = join(base, source === "desktop" ? ".vykor" : "root"), data = join(root, "data");
    const oldStore = new SessionStore({ path: join(base, "legacy", "sessions.db") });
    const oldPath = oldStore.path;
    oldStore.close();
    const original = readFileSync(oldPath);
    vi.stubEnv("HOME", base); vi.stubEnv("USERPROFILE", base);
    vi.stubEnv("APPDATA", join(base, "AppData", "Roaming"));
    vi.stubEnv("XDG_CONFIG_HOME", join(base, ".config"));
    const profile = process.platform === "win32" ? join(base, "AppData", "Roaming")
      : process.platform === "darwin" ? join(base, "Library", "Application Support") : join(base, ".config");
    const locationFile = source === "desktop" ? join(profile, "Vykor", "runtime-data-location.json") : join(data, "daemon", "data-location.json");
    mkdirSync(source === "desktop" ? join(profile, "Vykor") : join(data, "daemon"), { recursive: true });
    writeFileSync(locationFile, JSON.stringify({ version: 1,
      location: { directory: join(base, "legacy"), storePath: oldPath } }));
    vi.stubEnv("VYKOR_CONFIG_DIR", root);
    vi.stubEnv("VYKOR_DATA_DIR", source === "desktop" ? undefined : data);
    return { data, oldPath, original };
  }

  it.each(["registered", "desktop"])("refuses an external %s selection before a default Store can create an empty database", source => {
    const { data, oldPath, original } = selectedLegacyStore(source);
    failAttachmentAssembly(new Error("default Store was already created"));
    expect(() => createDefaultNodeApplication({ settings, log: () => {} })).toThrow(/data-root migrate/);
    expect(existsSync(join(data, "session-runtime", "sessions.db"))).toBe(false);
    expect(readFileSync(oldPath)).toEqual(original);
  });

  it("keeps an explicitly supplied embedded Store independent of legacy product selection", () => {
    selectedLegacyStore();
    const store = createStore(), expected = new Error("embedded application reached");
    failAttachmentAssembly(expected);
    expect(constructionFailure({ store, settings, log: () => {} })).toBe(expected);
    expect(store.sessions.list()).toEqual([]);
  });

  it("keeps an explicitly supplied database path independent of legacy product selection", () => {
    selectedLegacyStore();
    const expected = new Error("embedded application reached");
    failAttachmentAssembly(expected);
    expect(constructionFailure({ storePath: tempStorePath(), settings, log: () => {} })).toBe(expected);
  });

  it("accepts the current canonical record before a retained Desktop legacy selection", () => {
    const { data, oldPath, original } = selectedLegacyStore("desktop");
    const current = new SessionStore({ path: join(data, "session-runtime", "sessions.db") });
    current.close();
    mkdirSync(join(data, "daemon"), { recursive: true });
    writeFileSync(join(data, "daemon", "data-location.json"), JSON.stringify({ version: 1,
      location: { directory: data, storePath: join(data, "session-runtime", "sessions.db") } }));
    const expected = new Error("canonical application reached");
    failAttachmentAssembly(expected);
    expect(constructionFailure({ settings, log: () => {} })).toBe(expected);
    expect(existsSync(join(data, "session-runtime", "sessions.db"))).toBe(true);
    expect(readFileSync(oldPath)).toEqual(original);
  });
});

describe("createDefaultNodeApplication Store ownership", () => {
  it.each([undefined, true, false])(
    "closes its untransferred Store on synchronous construction failure (ownsStore=%s)",
    (ownsStore) => {
      const constructionError = new Error("attachment assembly failed");
      let createdStore: SessionStore | undefined;
      failAttachmentAssembly(constructionError, (store) => { createdStore = store; });

      expect(constructionFailure({
        storePath: tempStorePath(), ownsStore, settings, log: () => {},
      })).toBe(constructionError);

      expect(createdStore).toBeDefined();
      expect(() => createdStore!.listRetentionAudits()).toThrow();
    },
  );

  it.each([undefined, false])(
    "leaves a borrowed Store usable on synchronous construction failure (ownsStore=%s)",
    (ownsStore) => {
      const store = createStore();
      const close = vi.spyOn(store, "close");
      const constructionError = new Error("attachment assembly failed");
      failAttachmentAssembly(constructionError);

      expect(constructionFailure({
        store, ownsStore, settings, log: () => {},
      })).toBe(constructionError);

      expect(close).not.toHaveBeenCalled();
      expect(store.sessions.list()).toEqual([]);
      // 构造函数仍负责释放自己的 owner 租约，外借 Store 可以立即被接手。
      const lease = store.acquireApplicationOwner({
        ownerId: "replacement", pid: process.pid, staleAfterMs: 30_000,
        canTakeOver: () => false,
      });
      store.releaseApplicationOwner(lease);
    },
  );

  it("closes an explicitly transferred external Store on synchronous construction failure", () => {
    const store = createStore();
    const close = vi.spyOn(store, "close");
    const constructionError = new Error("attachment assembly failed");
    failAttachmentAssembly(constructionError);

    expect(constructionFailure({
      store, ownsStore: true, settings, log: () => {},
    })).toBe(constructionError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(() => store.listRetentionAudits()).toThrow();
  });

  it("preserves the construction and Store close errors when both fail", () => {
    const constructionError = new Error("attachment assembly failed");
    const closeError = new Error("Store close failed");
    failAttachmentAssembly(constructionError, (store) => {
      vi.spyOn(store, "close").mockImplementationOnce(() => { throw closeError; });
    });

    const failure = constructionFailure({ storePath: tempStorePath(), settings, log: () => {} });

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([constructionError, closeError]);
    expect((failure as AggregateError).errors[0]).toBe(constructionError);
    expect((failure as AggregateError).errors[1]).toBe(closeError);
  });

  it.each([
    { external: false, ownsStore: undefined, closes: true },
    { external: false, ownsStore: true, closes: true },
    { external: false, ownsStore: false, closes: false },
    { external: true, ownsStore: undefined, closes: false },
    { external: true, ownsStore: true, closes: true },
    { external: true, ownsStore: false, closes: false },
  ])("keeps successful close ownership ($external, $ownsStore)", async ({ external, ownsStore, closes }) => {
    const application = createDefaultNodeApplication({
      ...(external ? { store: createStore() } : { storePath: tempStorePath() }),
      ownsStore, settings, log: () => {},
    });
    stores.add(application.store);
    const close = vi.spyOn(application.store, "close");
    await application.ready();
    expect(close).not.toHaveBeenCalled();

    const closing = application.close();
    expect(application.close()).toBe(closing);
    await closing;
    await application.close();

    expect(close).toHaveBeenCalledTimes(closes ? 1 : 0);
    if (closes) expect(() => application.store.listRetentionAudits()).toThrow();
    else expect(application.store.sessions.list()).toEqual([]);
  });
});
