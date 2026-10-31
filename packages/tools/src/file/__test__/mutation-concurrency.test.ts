import type { ToolContext, ToolResult } from "@vykor/agent-contracts";
import type { EnvironmentReadBytesOptions } from "@vykor/environment";
import { hostFileMutationKey, withFileMutationLocks } from "@vykor/execution-node";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import { executeToolFixture } from "../../../test-helpers/tool-host-fixture.js";
import { createApplyPatchTool } from "../editing/apply-patch.js";
import { createFileEditTool } from "../editing/edit.js";
import { HostFileOperations, WslFileOperations, type FileOperations } from "../operations.js";
import { createFileWriteTool } from "../write.js";

const settings = {
  model: "fixture", apiFormat: "openai" as const, maxTurns: 1,
  permission: { mode: "default" as const }, sandbox: { enabled: false },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function latch() {
  const entered = deferred<void>();
  const released = deferred<void>();
  let isReleased = false;
  return {
    entered: entered.promise,
    get isReleased() { return isReleased; },
    async hold() { entered.resolve(); await released.promise; },
    release() { isReleased = true; released.resolve(); },
  };
}

type Hooks = {
  read?: (path: string, bytes: Uint8Array) => void | Promise<void>;
  write?: (path: string, content: string) => void | Promise<void>;
};

/** Only pause the real filesystem boundary; planning and atomic writes remain production code. */
class BoundaryFiles extends HostFileOperations {
  readonly lockRequested = deferred<readonly string[]>();
  constructor(private readonly hooks: Hooks = {}) { super(); }

  override async withMutationLock<T>(paths: readonly string[], work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.lockRequested.resolve(paths);
    return super.withMutationLock(paths, work, signal);
  }

  override async readBytes(path: string, options: EnvironmentReadBytesOptions = {}) {
    const bytes = await super.readBytes(path, options);
    await this.hooks.read?.(path, bytes);
    return bytes;
  }

  override async writeTextAtomic(path: string, content: string) {
    await this.hooks.write?.(path, content);
    await super.writeTextAtomic(path, content);
  }
}

function session(cwd: string, files: FileOperations, sessionId: string, abortSignal?: AbortSignal) {
  return {
    cwd, sessionId, abortSignal, settings,
    environment: {
      info: { kind: "local", pathStyle: process.platform === "win32" ? "windows" : "posix" },
      workspace: { kind: "local", hostRoot: cwd, executionRoot: cwd },
      files,
      paths: { resolve: async (path: string) => ({ executionPath: resolve(cwd, path), mountMode: "rw" }) },
    },
  } as unknown as ToolContext & { settings: typeof settings };
}

async function directory(work: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "oh-file-mutation-"));
  try { await work(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

/** Old tools never request a lock, so their completed operation also opens this checkpoint. */
async function attempted(files: BoundaryFiles, result: Promise<ToolResult>) {
  await Promise.race([files.lockRequested.promise, result]);
}

function patch(path: string, before: string, after: string) {
  return createTwoFilesPatch(path, path, before, after, undefined, undefined, { context: 0 });
}

describe("file mutation coordination across independent tool sessions", () => {
  it("preserves independent line edits after both sessions pass the write snapshot check", async () => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const overlappingReads: string[] = [];
      const firstFiles = new BoundaryFiles({ write: () => held.hold() });
      const secondFiles = new BoundaryFiles({ read: path => { if (!held.isReleased) overlappingReads.push(path); } });
      const first = executeToolFixture(createFileEditTool, { file_path: file, old_string: "alpha", new_string: "ALPHA" }, session(cwd, firstFiles, "first"));
      await held.entered;
      const second = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "BETA" }, session(cwd, secondFiles, "second"));
      try { await attempted(secondFiles, second); } finally { held.release(); }
      const results = await Promise.all([first, second]);
      expect(results.every(result => !result.isError)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("ALPHA\nBETA\n");
      expect(overlappingReads).toEqual([]);
    });
  });

  it("makes Write and Edit share the same path lock through the physical write", async () => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const firstFiles = new BoundaryFiles({ write: () => held.hold() });
      const secondFiles = new BoundaryFiles();
      const first = executeToolFixture(createFileWriteTool, { file_path: file, content: "WRITTEN\nbeta\n" }, session(cwd, firstFiles, "write"));
      await held.entered;
      const second = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "BETA" }, session(cwd, secondFiles, "edit"));
      try { await attempted(secondFiles, second); } finally { held.release(); }
      expect((await Promise.all([first, second])).every(result => !result.isError)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("WRITTEN\nBETA\n");
    });
  });

  it("holds ApplyPatch's lock while reading and planning, before its final recheck", async () => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      let firstRead = true;
      const firstFiles = new BoundaryFiles({ read: async () => { if (firstRead) { firstRead = false; await held.hold(); } } });
      const secondFiles = new BoundaryFiles();
      const first = executeToolFixture(createApplyPatchTool, { patch: patch("shared.txt", "alpha\nbeta\n", "ALPHA\nbeta\n") }, session(cwd, firstFiles, "patch"));
      await held.entered;
      const second = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "BETA" }, session(cwd, secondFiles, "edit"));
      try { await attempted(secondFiles, second); } finally { held.release(); }
      expect((await Promise.all([first, second])).every(result => !result.isError)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("ALPHA\nBETA\n");
    });
  });

  it.each(["unidentified", "wsl"] as const)("makes a %s backend serialize with a Host mutation of the same underlying file", async kind => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const backingFiles = new BoundaryFiles({ write: () => held.hold() });
      let files: FileOperations;
      if (kind === "unidentified") {
        files = new Proxy(backingFiles, {
          get(target, property) {
            if (property === "withMutationLock") return undefined;
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      } else {
        // Exercise the actual WSL lock, while keeping its file I/O on a real local fixture.
        // Lock selection must not launch a WSL process to guess its host identity.
        const wsl = new WslFileOperations({ process: { execProcess() { throw new Error("mutation locking must not launch a process"); } } } as never);
        wsl.stat = (_path, signal) => backingFiles.stat(file, signal);
        wsl.readBytes = (_path, options) => backingFiles.readBytes(file, options && "aborted" in options ? { signal: options } : options);
        wsl.writeTextAtomic = (_path, content) => backingFiles.writeTextAtomic(file, content);
        files = wsl;
      }
      const ordinaryContext = session(cwd, files, `${kind}-writer`);
      const firstPath = kind === "wsl" ? "/work/shared.txt" : file;
      const firstContext = kind === "wsl" ? {
        ...ordinaryContext,
        environment: {
          ...ordinaryContext.environment!,
          info: { ...ordinaryContext.environment!.info, kind: "wsl", pathStyle: "posix" },
          paths: { resolve: async (path: string) => ({ executionPath: path, mountMode: "rw" }) },
        },
      } as unknown as typeof ordinaryContext : ordinaryContext;
      const hostFiles = new BoundaryFiles();
      const first = executeToolFixture(createFileEditTool, { file_path: firstPath, old_string: "alpha", new_string: "BACKEND" }, firstContext);
      await held.entered;
      const second = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "HOST" }, session(cwd, hostFiles, "host-editor"));
      try { await attempted(hostFiles, second); } finally { held.release(); }
      expect((await Promise.all([first, second])).every(result => !result.isError)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("BACKEND\nHOST\n");
    });
  });

  it("coordinates every patch target in opposite input orders without blocking an unrelated file", async () => {
    await directory(async cwd => {
      const a = join(cwd, "a.txt");
      const z = join(cwd, "z.txt");
      const independent = join(cwd, "independent.txt");
      await Promise.all([a, z, independent].map(path => writeFile(path, "alpha\nbeta\n")));
      const held = latch();
      let firstRead = true;
      const firstFiles = new BoundaryFiles({ read: async () => { if (firstRead) { firstRead = false; await held.hold(); } } });
      const secondFiles = new BoundaryFiles();
      const firstPatch = patch("z.txt", "alpha\nbeta\n", "ALPHA\nbeta\n") + patch("a.txt", "alpha\nbeta\n", "ALPHA\nbeta\n");
      const secondPatch = patch("a.txt", "alpha\nbeta\n", "alpha\nBETA\n") + patch("z.txt", "alpha\nbeta\n", "alpha\nBETA\n");
      const first = executeToolFixture(createApplyPatchTool, { patch: firstPatch }, session(cwd, firstFiles, "patch-z-a"));
      await held.entered;
      const second = executeToolFixture(createApplyPatchTool, { patch: secondPatch }, session(cwd, secondFiles, "patch-a-z"));
      let unrelated: ToolResult;
      let unrelatedContent: string;
      try {
        await attempted(secondFiles, second);
        unrelated = await executeToolFixture(createFileEditTool, { file_path: independent, old_string: "alpha", new_string: "INDEPENDENT" }, session(cwd, new BoundaryFiles(), "independent"));
        unrelatedContent = await readFile(independent, "utf8");
      } finally { held.release(); }
      expect((await Promise.all([first, second])).every(result => !result.isError)).toBe(true);
      expect(unrelated!.isError).toBeFalsy();
      expect(unrelatedContent!).toBe("INDEPENDENT\nbeta\n");
      expect(new Set(await firstFiles.lockRequested.promise)).toEqual(new Set([a, z]));
      expect(new Set(await secondFiles.lockRequested.promise)).toEqual(new Set([a, z]));
      expect(await readFile(a, "utf8")).toBe("ALPHA\nBETA\n");
      expect(await readFile(z, "utf8")).toBe("ALPHA\nBETA\n");
    });
  });

  it("releases a failed writer's lock so the next session can read and edit the actual file", async () => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const firstFiles = new BoundaryFiles({ write: async () => { await held.hold(); throw new Error("injected disk boundary failure"); } });
      const secondFiles = new BoundaryFiles();
      const first = executeToolFixture(createFileEditTool, { file_path: file, old_string: "alpha", new_string: "ALPHA" }, session(cwd, firstFiles, "failed"));
      await held.entered;
      const second = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "BETA" }, session(cwd, secondFiles, "after-failure"));
      try { await attempted(secondFiles, second); } finally { held.release(); }
      expect(await first).toMatchObject({ isError: true, executionState: "unknown" });
      expect((await second).isError).toBeFalsy();
      expect(await readFile(file, "utf8")).toBe("alpha\nBETA\n");
    });
  });

  it("cancels a waiting session without reading its target or releasing the active writer", async () => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const controller = new AbortController();
      const waitingReads: string[] = [];
      const nextReadsWhileHeld: string[] = [];
      const firstFiles = new BoundaryFiles({ write: () => held.hold() });
      const waitingFiles = new BoundaryFiles({ read: path => { waitingReads.push(path); } });
      const nextFiles = new BoundaryFiles({ read: path => { if (!held.isReleased) nextReadsWhileHeld.push(path); } });
      const first = executeToolFixture(createFileEditTool, { file_path: file, old_string: "alpha", new_string: "ALPHA" }, session(cwd, firstFiles, "active"));
      await held.entered;
      const waiting = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "CANCELLED" }, session(cwd, waitingFiles, "waiting", controller.signal));
      let next: Promise<ToolResult> | undefined;
      let cancelled: ToolResult;
      try {
        await attempted(waitingFiles, waiting);
        controller.abort(new Error("cancel waiting mutation"));
        cancelled = await waiting;
        next = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "BETA" }, session(cwd, nextFiles, "next"));
        await attempted(nextFiles, next);
      } finally { held.release(); }
      expect((await first).isError).toBeFalsy();
      expect((await next!).isError).toBeFalsy();
      expect(cancelled!).toMatchObject({ isError: true, executionState: "not_started" });
      expect(waitingReads).toEqual([]);
      expect(nextReadsWhileHeld).toEqual([]);
      expect(await readFile(file, "utf8")).toBe("ALPHA\nBETA\n");
    });
  });

  it("keeps the path locked after active cancellation until the in-flight write settles", async () => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const controller = new AbortController();
      const overlappingReads: string[] = [];
      const firstFiles = new BoundaryFiles({ write: () => held.hold() });
      const secondFiles = new BoundaryFiles({ read: path => { if (!held.isReleased) overlappingReads.push(path); } });
      const first = executeToolFixture(createFileEditTool, { file_path: file, old_string: "alpha", new_string: "ALPHA" }, session(cwd, firstFiles, "cancel-active", controller.signal));
      await held.entered;
      controller.abort(new Error("cancel active mutation"));
      const second = executeToolFixture(createFileEditTool, { file_path: file, old_string: "beta", new_string: "BETA" }, session(cwd, secondFiles, "after-active-abort"));
      try { await attempted(secondFiles, second); } finally { held.release(); }
      await first;
      expect((await second).isError).toBeFalsy();
      expect(overlappingReads).toEqual([]);
      expect(await readFile(file, "utf8")).toBe("ALPHA\nBETA\n");
    });
  });

  it.each([
    { name: "Write", factory: createFileWriteTool, input: { file_path: "shared.txt", content: "CANCELLED\n" } },
    { name: "Edit", factory: createFileEditTool, input: { file_path: "shared.txt", old_string: "alpha", new_string: "CANCELLED" } },
    { name: "ApplyPatch", factory: createApplyPatchTool, input: { patch: patch("shared.txt", "alpha\nbeta\n", "CANCELLED\nbeta\n") } },
  ])("cancels the default Host $name without an environment while another session holds its path", async ({ factory, input }) => {
    await directory(async cwd => {
      const file = join(cwd, "shared.txt");
      await writeFile(file, "alpha\nbeta\n");
      const held = latch();
      const holder = withFileMutationLocks([await hostFileMutationKey(file)], () => held.hold());
      await held.entered;
      const controller = new AbortController();
      const waiting = executeToolFixture(factory, input, { cwd, settings, abortSignal: controller.signal });
      let result: ToolResult;
      try {
        await new Promise<void>(done => setImmediate(done));
        controller.abort(new Error("cancel default Host mutation"));
        result = await waiting;
      } finally { held.release(); await holder; }
      expect(result!).toMatchObject({ isError: true, executionState: "not_started" });
      expect(await readFile(file, "utf8")).toBe("alpha\nbeta\n");
    });
  });
});
