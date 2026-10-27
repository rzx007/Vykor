import { mkdtempSync, rmSync } from "node:fs";
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
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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
