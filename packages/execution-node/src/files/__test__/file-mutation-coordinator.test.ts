import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hostFileMutationKey, withFileMutationLocks, withUnidentifiedFileMutationLock } from "../file-mutation-coordinator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file mutation locks", () => {
  it("serializes one key in arrival order and returns each work result", async () => {
    const finishFirst = deferred();
    const firstStarted = deferred();
    const entered: number[] = [];
    const first = withFileMutationLocks(["serial"], async () => {
      entered.push(1);
      firstStarted.resolve();
      await finishFirst.promise;
      return "first";
    });
    await firstStarted.promise;
    const second = withFileMutationLocks(["serial"], async () => { entered.push(2); return "second"; });
    const third = withFileMutationLocks(["serial"], async () => { entered.push(3); return "third"; });
    await nextTurn();
    expect(entered).toEqual([1]);
    finishFirst.resolve();
    expect(await Promise.all([first, second, third])).toEqual(["first", "second", "third"]);
    expect(entered).toEqual([1, 2, 3]);
  });

  it("allows unrelated keys to run while another mutation is active", async () => {
    const finishFirst = deferred();
    const firstStarted = deferred();
    const first = withFileMutationLocks(["independent-a"], async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;
    try {
      expect(await withFileMutationLocks(["independent-b"], async () => "ran")).toBe("ran");
    } finally {
      finishFirst.resolve();
      await first;
    }
  });

  it("sorts and deduplicates overlapping key sets to avoid deadlock", async () => {
    const entered: string[] = [];
    await Promise.all([
      withFileMutationLocks(["ordered-b", "ordered-a", "ordered-a"], async () => { entered.push("first"); }),
      withFileMutationLocks(["ordered-a", "ordered-b"], async () => { entered.push("second"); }),
    ]);
    expect(entered).toEqual(["first", "second"]);
  }, 2000);

  it("releases locks after a work error", async () => {
    const error = new Error("write failed");
    await expect(withFileMutationLocks(["error"], async () => { throw error; })).rejects.toBe(error);
    expect(await withFileMutationLocks(["error"], async () => "released")).toBe("released");
  });

  it("rejects an already aborted request before starting work, including an empty key set", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before admission");
    controller.abort(reason);
    let started = false;
    for (const keys of [[], ["pre-aborted"]]) {
      await expect(withFileMutationLocks(keys, async () => { started = true; }, controller.signal)).rejects.toBe(reason);
    }
    expect(started).toBe(false);
  });

  it("removes an aborted waiter and releases its partially acquired keys", async () => {
    const finishHolder = deferred();
    const holderStarted = deferred();
    const holder = withFileMutationLocks(["abort-b"], async () => {
      holderStarted.resolve();
      await finishHolder.promise;
    });
    await holderStarted.promise;
    const controller = new AbortController();
    let abortedWorkStarted = false;
    const waiting = withFileMutationLocks(["abort-a", "abort-b"], async () => { abortedWorkStarted = true; }, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await nextTurn();
    controller.abort();
    await rejected;
    expect(await withFileMutationLocks(["abort-a"], async () => "released partial")).toBe("released partial");
    const afterAbort = withFileMutationLocks(["abort-b"], async () => "next waiter");
    finishHolder.resolve();
    await holder;
    expect(await afterAbort).toBe("next waiter");
    expect(abortedWorkStarted).toBe(false);
  });

  it("holds locks until active work finishes even when its signal is aborted", async () => {
    const finishFirst = deferred();
    const firstStarted = deferred();
    const controller = new AbortController();
    const entered: string[] = [];
    const first = withFileMutationLocks(["active-abort"], async () => {
      entered.push("first");
      firstStarted.resolve();
      await finishFirst.promise;
      return "finished";
    }, controller.signal);
    await firstStarted.promise;
    controller.abort();
    const second = withFileMutationLocks(["active-abort"], async () => { entered.push("second"); });
    await nextTurn();
    expect(entered).toEqual(["first"]);
    finishFirst.resolve();
    expect(await first).toBe("finished");
    await second;
    expect(entered).toEqual(["first", "second"]);
  });

  it("shares queues across separate module instances", async () => {
    const finishFirst = deferred();
    const firstStarted = deferred();
    const first = withFileMutationLocks(["module-copies"], async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;
    vi.resetModules();
    const copy = await import("../file-mutation-coordinator.js");
    let secondStarted = false;
    const second = copy.withFileMutationLocks(["module-copies"], async () => { secondStarted = true; });
    await nextTurn();
    expect(secondStarted).toBe(false);
    finishFirst.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it("discards idle queues after all requests have finished", async () => {
    await withFileMutationLocks(["cleanup-success"], async () => undefined);
    const registry = Reflect.get(globalThis, Symbol.for("vykor.execution-node.file-mutation-locks.v1")) as Map<string, unknown>;
    expect(registry.has("cleanup-success")).toBe(false);
    expect(registry.size).toBe(0);
  });
});

describe("unidentified file mutations", () => {
  it("waits for active known mutations and blocks later known mutations fairly", async () => {
    const finishKnown = deferred();
    const knownStarted = deferred();
    const finishUnknown = deferred();
    const unknownStarted = deferred();
    const entered: string[] = [];
    const first = withFileMutationLocks(["barrier-first"], async () => {
      entered.push("first known");
      knownStarted.resolve();
      await finishKnown.promise;
    });
    await knownStarted.promise;
    const unknown = withUnidentifiedFileMutationLock(async () => {
      entered.push("unknown");
      unknownStarted.resolve();
      await finishUnknown.promise;
      return "unknown result";
    });
    const second = withFileMutationLocks(["barrier-second"], async () => { entered.push("second known"); });
    await nextTurn();
    expect(entered).toEqual(["first known"]);
    finishKnown.resolve();
    await first;
    await unknownStarted.promise;
    expect(entered).toEqual(["first known", "unknown"]);
    finishUnknown.resolve();
    expect(await unknown).toBe("unknown result");
    await second;
    expect(entered).toEqual(["first known", "unknown", "second known"]);
  });

  it("removes a cancelled exclusive waiter so later shared mutations can proceed", async () => {
    const finishFirst = deferred();
    const firstStarted = deferred();
    const first = withFileMutationLocks(["barrier-cancel-first"], async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;
    const controller = new AbortController();
    let unknownStarted = false;
    const unknown = withUnidentifiedFileMutationLock(async () => { unknownStarted = true; }, controller.signal);
    const rejected = expect(unknown).rejects.toMatchObject({ name: "AbortError" });
    const second = withFileMutationLocks(["barrier-cancel-second"], async () => "second proceeded");
    controller.abort();
    await rejected;
    try {
      expect(await second).toBe("second proceeded");
      expect(unknownStarted).toBe(false);
    } finally {
      finishFirst.resolve();
      await first;
    }
  });

  it("does not release an active exclusive mutation on abort and releases after its error", async () => {
    const finishUnknown = deferred();
    const unknownStarted = deferred();
    const controller = new AbortController();
    const failure = new Error("unknown write failed");
    const unknown = withUnidentifiedFileMutationLock(async () => {
      unknownStarted.resolve();
      await finishUnknown.promise;
      throw failure;
    }, controller.signal);
    const rejected = expect(unknown).rejects.toBe(failure);
    await unknownStarted.promise;
    controller.abort();
    let knownStarted = false;
    const known = withFileMutationLocks(["barrier-active-abort"], async () => { knownStarted = true; });
    await nextTurn();
    expect(knownStarted).toBe(false);
    finishUnknown.resolve();
    await rejected;
    await known;
    expect(knownStarted).toBe(true);
  });

  it("cancels shared admission behind an exclusive mutation without leaving a queued permit", async () => {
    const finishUnknown = deferred();
    const unknownStarted = deferred();
    const unknown = withUnidentifiedFileMutationLock(async () => {
      unknownStarted.resolve();
      await finishUnknown.promise;
    });
    await unknownStarted.promise;
    const controller = new AbortController();
    let cancelledStarted = false;
    const cancelled = withFileMutationLocks(["cancel-shared"], async () => { cancelledStarted = true; }, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const nextUnknown = withUnidentifiedFileMutationLock(async () => "next exclusive");
    controller.abort();
    await rejected;
    finishUnknown.resolve();
    await unknown;
    expect(await nextUnknown).toBe("next exclusive");
    expect(cancelledStarted).toBe(false);
    const state = Reflect.get(globalThis, Symbol.for("vykor.execution-node.file-mutation-barrier.v1"));
    expect(state).toEqual({ readers: 0, writer: false, waiters: [] });
  });

  it("shares the exclusive barrier across separate module instances", async () => {
    const finishUnknown = deferred();
    const unknownStarted = deferred();
    const unknown = withUnidentifiedFileMutationLock(async () => {
      unknownStarted.resolve();
      await finishUnknown.promise;
    });
    await unknownStarted.promise;
    vi.resetModules();
    const copy = await import("../file-mutation-coordinator.js");
    let knownStarted = false;
    const known = copy.withFileMutationLocks(["barrier-module-copies"], async () => { knownStarted = true; });
    await nextTurn();
    expect(knownStarted).toBe(false);
    finishUnknown.resolve();
    await Promise.all([unknown, known]);
    expect(knownStarted).toBe(true);
  });
});

describe("host file mutation keys", () => {
  it("resolves relative paths to the same key as their absolute form", async () => {
    const path = "missing-key-parent/file.txt";
    expect(await hostFileMutationKey(path)).toBe(await hostFileMutationKey(resolve(path)));
  });

  it("uses real ancestors so an absent child has one key through directory aliases", async ({ skip }) => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target");
    const alias = join(directory, "alias");
    await mkdir(target);
    try {
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }
    expect(await hostFileMutationKey(join(alias, "new", "file.txt")))
      .toBe(await hostFileMutationKey(join(target, "new", "file.txt")));
  });

  it("keeps the same key when missing directories and their file are created", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "NewDirectory", "NewFile.txt");
    const before = await hostFileMutationKey(path);
    await mkdir(join(directory, "NewDirectory"));
    await writeFile(path, "content");
    expect(await hostFileMutationKey(path)).toBe(before);
  });

  it("preserves ENOTDIR when an existing ordinary file is used as a parent", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "ordinary-file");
    await writeFile(path, "content");
    await expect(hostFileMutationKey(join(path, "child.txt"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it.runIf(process.platform !== "win32")("gives an existing file and its symlink the same key", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "file.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(path, "content");
    await symlink(path, alias);
    expect(await hostFileMutationKey(alias)).toBe(await hostFileMutationKey(path));
  });

  it.runIf(process.platform !== "win32")("rejects dangling symlinks rather than assigning unstable keys", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "future", "file.txt");
    const alias = join(directory, "alias.txt");
    await symlink(target, alias);
    await expect(hostFileMutationKey(alias)).rejects.toMatchObject({ code: "ENOTSUP" });
    await expect(hostFileMutationKey(join(alias, "child.txt"))).rejects.toMatchObject({ code: "ENOTSUP" });
  });

  it("rejects cancelled path resolution", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(hostFileMutationKey("missing/file", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it.runIf(process.platform === "win32")("conservatively shares absent case variants on Windows", async () => {
    const directory = await temporaryDirectory();
    expect(await hostFileMutationKey(join(directory, "NEW", "File.txt")))
      .toBe(await hostFileMutationKey(join(directory, "new", "file.txt")));
  });

  it.runIf(process.platform === "win32")("rejects ambiguous Win32 names instead of assigning separate lock keys", async () => {
    const directory = await temporaryDirectory();
    for (const name of ["file.txt.", "file.txt ", "file.txt:stream", "NUL.txt", "COM1"]) {
      await expect(hostFileMutationKey(join(directory, name))).rejects.toMatchObject({ code: "ENOTSUP" });
    }
    await expect(hostFileMutationKey("\\\\.\\C:\\file.txt")).rejects.toMatchObject({ code: "ENOTSUP" });
  });

  it("conservatively shares absent case variants on a POSIX host too", async () => {
    const directory = await temporaryDirectory();
    // The physical test filesystem can differ from the host platform. Exercise
    // the non-Windows identity branch without relying on CI's volume format.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try {
      const before = await hostFileMutationKey(join(directory, "NEW", "File.txt"));
      expect(await hostFileMutationKey(join(directory, "new", "file.txt"))).toBe(before);
      await mkdir(join(directory, "NEW"));
      await writeFile(join(directory, "NEW", "File.txt"), "content");
      expect(await hostFileMutationKey(join(directory, "NEW", "File.txt"))).toBe(before);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.each([
    ["caf\u00e9.txt", "cafe\u0301.txt"],
    ["stra\u00dfe.txt", "stra\u1e9ee.txt"],
    ["kelvin\u212a.txt", "kelvinK.txt"],
  ])("conservatively shares Unicode spelling variants through creation: %s / %s", async (left, right) => {
    const directory = await temporaryDirectory();
    const original = join(directory, left);
    const variant = join(directory, right);
    const before = await hostFileMutationKey(original);
    expect(await hostFileMutationKey(variant)).toBe(before);
    await writeFile(original, "content");
    expect(await hostFileMutationKey(original)).toBe(before);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vykor-file-mutation-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}
