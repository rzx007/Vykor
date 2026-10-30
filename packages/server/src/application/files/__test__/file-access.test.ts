import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import { createWorkspaceBinding } from "@vykor/environment";
import type { Settings } from "@vykor/host-config";
import { PermissionChecker } from "@vykor/permissions";
import { createExecutionEnvironment, createWslPathResolver, resolveExecutionEnvironmentConfig } from "@vykor/sandbox";
import { createSessionFileAccess } from "../file-access.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of cleanup.splice(0).reverse()) await release();
});

function settings(patch: Partial<Settings> = {}): Settings {
  return { model: "fixture", apiFormat: "openai", maxTurns: 1, permission: { mode: "default" }, ...patch };
}

async function localEnvironment() {
  const root = await mkdtemp(join(tmpdir(), "vykor-files-access-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "visible\n");
  await writeFile(join(root, "secret.txt"), "private\n");
  const config = settings();
  const environment = await createExecutionEnvironment({
    config: resolveExecutionEnvironmentConfig({ surface: "desktop_managed", cwd: root, settings: config }),
    settings: config,
    binding: createWorkspaceBinding({ kind: "local", hostRoot: root, executionRoot: root }),
    sessionId: "file-access-test", userSkillsRoot: root,
  });
  cleanup.push(() => environment.release());
  return { root, environment };
}

async function wslEnvironment(aliases: Record<string, string> = {}) {
  const { environment: local } = await localEnvironment();
  const workspace = createWorkspaceBinding({ kind: "wsl", hostRoot: "D:\\workspace", executionRoot: "/mnt/d/workspace" });
  const resolver = createWslPathResolver(workspace);
  const environment: ExecutionEnvironmentHandle = {
    ...local, workspace,
    info: { ...local.info, kind: "wsl", pathStyle: "posix", cwd: workspace.executionRoot, mounts: [{ path: workspace.executionRoot, mode: "rw", purpose: "workspace" }] },
    paths: {
      ...resolver,
      async canonicalize(path: string) {
        if (!posix.isAbsolute(path) || path.includes("\\")) throw new Error(`Host path reached WSL canonicalize: ${path}`);
        return aliases[path] ?? path;
      },
    },
  };
  return environment;
}

describe("session file access", () => {
  it("returns a canonical file path while keeping the requested workspace-relative path", async () => {
    const { root, environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings());
    expect(await access.authorize("./src/main.ts", "Read")).toEqual({
      executionPath: await realpath(join(root, "src", "main.ts")), sourcePath: join(root, "src", "main.ts"), relativePath: "src/main.ts",
    });
    expect(await access.authorize(".", "Glob")).toEqual({ executionPath: await realpath(root), sourcePath: root, relativePath: "." });
  });

  it.each([
    ["empty", ""], ["parent", "../secret.txt"], ["nested parent", "src/../secret.txt"], ["POSIX absolute", "/etc/passwd"],
    ["Windows absolute", "C:/Windows/win.ini"], ["backslash", "src\\main.ts"], ["NUL", "src/\0main.ts"], ["too long", "a".repeat(4097)],
  ])(
    "rejects %s relative paths before resolving a target", async (_label, path) => {
      const { environment } = await localEnvironment();
      const access = await createSessionFileAccess(environment, settings());
      const canonicalize = vi.spyOn(environment.paths, "canonicalize");
      await expect(access.authorize(path, "Read")).rejects.toMatchObject({ code: "file_invalid_request" });
      expect(canonicalize).not.toHaveBeenCalled();
    },
  );

  it("refuses Windows alternate data streams", async () => {
    const { environment } = await localEnvironment();
    const windows = { ...environment, info: { ...environment.info, pathStyle: "windows" as const } };
    const access = await createSessionFileAccess(windows, settings());
    await expect(access.authorize("secret.txt:stream", "Read")).rejects.toMatchObject({ code: "file_invalid_request" });
  });

  it("applies explicit path and tool denies before filesystem canonicalization, even in full access", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings({ permission: {
      mode: "full_access", pathRules: [{ pattern: "secret.txt", allow: false }], deniedTools: ["Grep"], autoApproveTools: ["Read", "Grep"],
    } }));
    const canonicalize = vi.spyOn(environment.paths, "canonicalize");
    await expect(access.authorize("secret.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("src/main.ts", "Grep")).rejects.toMatchObject({ code: "file_forbidden" });
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("treats the configured wildcard as allowing the existing file tools", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings({ permission: { mode: "default", allowedTools: ["*"] } }));
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ relativePath: "src/main.ts" });
  });

  it("keeps an explicit allowed tool ceiling above auto approval and path allows", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings({ permission: {
      mode: "default", allowedTools: ["Read"], autoApproveTools: ["Grep"], pathRules: [{ pattern: "src/*", allow: true }],
    } }));
    const canonicalize = vi.spyOn(environment.paths, "canonicalize");
    await expect(access.authorize("src/main.ts", "Grep")).rejects.toMatchObject({ code: "file_forbidden" });
    expect(canonicalize).not.toHaveBeenCalled();
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ relativePath: "src/main.ts" });
  });

  it("refuses an ask decision without exposing its host path reason", async () => {
    const { root, environment } = await localEnvironment();
    vi.spyOn(PermissionChecker.prototype, "checkTool").mockResolvedValue({ action: "ask", reason: `Confirm ${root}` });
    const access = await createSessionFileAccess(environment, settings());
    const error = await access.authorize("src/main.ts", "Read").catch(error => error);
    expect(error).toMatchObject({ code: "file_forbidden" });
    expect(error.message).not.toContain(root);
  });

  it("keeps sandbox denyRead active when sandbox is off", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings({ permission: { mode: "full_access" }, sandbox: {
      enabled: false, filesystem: { denyRead: ["secret.txt"] },
    } }));
    const canonicalize = vi.spyOn(environment.paths, "canonicalize");
    await expect(access.authorize("secret.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    expect(canonicalize).not.toHaveBeenCalled();
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ relativePath: "src/main.ts" });
  });

  it("keeps missing sandbox deny roots harmless while applying the remaining policy", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings({ sandbox: {
      enabled: true, filesystem: { allowRead: ["."], denyRead: ["missing/nested"] },
    } }));
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ relativePath: "src/main.ts" });
  });

  it("honors enabled sandbox read roots without expanding the workspace boundary", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings({ sandbox: {
      enabled: true, filesystem: { allowRead: ["src"], extraAllowedRoots: ["../outside"] },
    } }));
    await expect(access.authorize("secret.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ relativePath: "src/main.ts" });
  });

  it("rejects a symlink outside the workspace and applies canonical path denies to an inside link", async context => {
    const { root, environment } = await localEnvironment();
    const outside = await mkdtemp(join(tmpdir(), "vykor-files-outside-"));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "outside.txt"), "outside\n");
    try {
      await symlink(outside, join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
      await symlink(join(root, "src"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    const allowed = await createSessionFileAccess(environment, settings());
    await expect(allowed.authorize("alias/main.ts", "Read")).resolves.toEqual({
      executionPath: await realpath(join(root, "src", "main.ts")), sourcePath: join(root, "alias", "main.ts"), relativePath: "alias/main.ts",
    });
    const access = await createSessionFileAccess(environment, settings({ permission: {
      mode: "default", pathRules: [{ pattern: "src/main.ts", allow: false }],
    } }));
    await expect(access.authorize("outside/outside.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("alias/main.ts", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    const sandbox = await createSessionFileAccess(environment, settings({ sandbox: { enabled: false, filesystem: { denyRead: ["src"] } } }));
    await expect(sandbox.authorize("alias/main.ts", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
  });

  it("returns file_not_found with no absolute path when canonicalization finds a missing file", async () => {
    const { root, environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings());
    const error = await access.authorize("missing.txt", "Read").catch(error => error);
    expect(error).toMatchObject({ code: "file_not_found" });
    expect(error.message).not.toContain(root);
  });

  it("rechecks a sandbox deny link when its target changes", async context => {
    const { root, environment } = await localEnvironment();
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other", "main.ts"), "other\n");
    try { await symlink(join(root, "src"), join(root, "denied"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    const access = await createSessionFileAccess(environment, settings({ sandbox: { enabled: false, filesystem: { denyRead: ["denied"] } } }));
    await expect(access.authorize("other/main.ts", "Read")).resolves.toMatchObject({ relativePath: "other/main.ts" });
    await rm(join(root, "denied"));
    await symlink(join(root, "other"), join(root, "denied"), process.platform === "win32" ? "junction" : "dir");
    await expect(access.authorize("other/main.ts", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
  });

  it("stops before and during canonicalization on cancellation", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings());
    const controller = new AbortController();
    controller.abort();
    await expect(access.authorize("src/main.ts", "Read", controller.signal)).rejects.toMatchObject({ code: "file_cancelled" });
    const pending = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    environment.paths.canonicalize = (_path, signal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Cancelled path verification.")), { once: true });
      markStarted();
    });
    const read = access.authorize("src/main.ts", "Read", pending.signal);
    await started;
    pending.abort();
    await expect(read).rejects.toMatchObject({ code: "file_cancelled" });
  });

  it("waits for cancelled canonicalization cleanup before returning to the service", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings());
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let markAborted!: () => void;
    const aborted = new Promise<void>(resolve => { markAborted = resolve; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    environment.paths.canonicalize = async (_path, signal) => {
      await new Promise<void>(resolve => {
        signal?.addEventListener("abort", () => { markAborted(); resolve(); }, { once: true });
        markStarted();
      });
      await cleanup;
      throw new Error("The cancelled path transport was cleaned up.");
    };
    let finished = false;
    const outcome = access.authorize("src/main.ts", "Read", controller.signal)
      .catch(error => error).finally(() => { finished = true; });
    await started;
    controller.abort();
    await aborted;
    await new Promise(resolve => setImmediate(resolve));
    try { expect(finished).toBe(false); }
    finally { finishCleanup(); }
    await expect(outcome).resolves.toMatchObject({ code: "file_cancelled" });
  });

  it("consumes a transport rejection when it cancels while canonicalization starts", async () => {
    const { environment } = await localEnvironment();
    const access = await createSessionFileAccess(environment, settings());
    const controller = new AbortController();
    environment.paths.canonicalize = () => {
      controller.abort();
      return Promise.reject(new Error("The cancelled transport finished rejecting."));
    };
    await expect(access.authorize("src/main.ts", "Read", controller.signal)).rejects.toMatchObject({ code: "file_cancelled" });
    await new Promise(resolve => setImmediate(resolve));
  });

  it("fails closed if the environment cannot verify real paths", async () => {
    const { environment } = await localEnvironment();
    const unsupported = { ...environment, paths: { ...environment.paths, canonicalize: undefined } };
    const access = await createSessionFileAccess(unsupported, settings());
    await expect(access.authorize("src/main.ts", "Read")).rejects.toMatchObject({ code: "file_not_supported" });
  });

  it("uses POSIX canonical paths in WSL and permits colon filenames", async () => {
    const environment = await wslEnvironment();
    const access = await createSessionFileAccess(environment, settings());
    await expect(access.authorize("src/name:1.ts", "Read")).resolves.toEqual({
      executionPath: "/mnt/d/workspace/src/name:1.ts", sourcePath: "/mnt/d/workspace/src/name:1.ts", relativePath: "src/name:1.ts",
    });
  });

  it("checks WSL canonical aliases and host-configured path rules in the correct filesystem", async () => {
    const environment = await wslEnvironment({ "/mnt/d/workspace/alias.txt": "/mnt/d/workspace/secret.txt", "/mnt/d/workspace/out.txt": "/etc/passwd" });
    const access = await createSessionFileAccess(environment, settings({ permission: {
      mode: "full_access", pathRules: [{ pattern: "D:\\WORKSPACE\\secret.txt", allow: false }],
    } }));
    await expect(access.authorize("secret.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("alias.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("out.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ executionPath: "/mnt/d/workspace/src/main.ts" });
  });

  it("applies WSL sandbox denyRead paths without using host filesystem validation", async () => {
    const environment = await wslEnvironment({ "/mnt/d/workspace/alias.txt": "/mnt/d/workspace/secret.txt" });
    const access = await createSessionFileAccess(environment, settings({ sandbox: {
      enabled: false, filesystem: { denyRead: ["D:\\workspace\\secret.txt"] },
    } }));
    await expect(access.authorize("alias.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
    await expect(access.authorize("src/main.ts", "Read")).resolves.toMatchObject({ executionPath: "/mnt/d/workspace/src/main.ts" });
  });

  it("preserves case-insensitive Windows sandbox deny rules in WSL", async () => {
    const environment = await wslEnvironment();
    const access = await createSessionFileAccess(environment, settings({ sandbox: {
      enabled: false, filesystem: { denyRead: ["D:\\WORKSPACE\\secret.txt"] },
    } }));
    await expect(access.authorize("secret.txt", "Read")).rejects.toMatchObject({ code: "file_forbidden" });
  });

  it("fails closed for mixed host and POSIX absolute permission rules in WSL", async () => {
    const environment = await wslEnvironment();
    const access = await createSessionFileAccess(environment, settings({ permission: {
      mode: "default", pathRules: [{ pattern: "D:\\workspace\\secret.txt", allow: false }, { pattern: "/mnt/d/workspace/src/*", allow: true }],
    } }));
    await expect(access.authorize("src/main.ts", "Read")).rejects.toMatchObject({ code: "file_not_supported" });
  });

  it("fails closed for WSL rules which cannot be safely mapped", async () => {
    const environment = await wslEnvironment();
    const access = await createSessionFileAccess(environment, settings({ permission: {
      mode: "default", pathRules: [{ pattern: "\\\\server\\share\\secret.txt", allow: false }],
    } }));
    await expect(access.authorize("src/main.ts", "Read")).rejects.toMatchObject({ code: "file_not_supported" });
  });
});
