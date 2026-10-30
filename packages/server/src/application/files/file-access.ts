import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import type { Settings } from "@vykor/host-config";
import { posix, win32 } from "node:path";
import { resolveAllowedToolNames } from "@vykor/agent-contracts";
import { PermissionChecker } from "@vykor/permissions";
import { SessionFileError } from "@vykor/domain-contracts/files";
import { resolveSandboxPolicy } from "@vykor/sandbox";

type FileReadTool = "Read" | "Glob" | "Grep";
type AuthorizedFilePath = {
  executionPath: string;
  /** Original resolved path, for inspecting link metadata only. */
  sourcePath: string;
  relativePath: string;
};

/** A workspace ceiling applies independently of tool approval or sandbox mode. */
export async function createSessionFileAccess(environment: ExecutionEnvironmentHandle, settings: Settings) {
  const paths = environment.info.pathStyle === "windows" ? win32 : posix;
  const policy = resolveSandboxPolicy({ cwd: environment.workspace.hostRoot, settings });
  let canonicalRoot: string | undefined;

  const forbidden = () => new SessionFileError("file_forbidden", "Reading this path is not allowed by the session policy.");
  const unsupported = () => new SessionFileError("file_not_supported", "The session environment cannot verify this file access policy.");

  async function canonicalize(path: string, signal?: AbortSignal): Promise<string> {
    if (!environment.paths.canonicalize) throw unsupported();
    checkCancelled(signal);
    try {
      const canonical = await environment.paths.canonicalize(path, signal);
      checkCancelled(signal);
      if (!paths.isAbsolute(canonical)) throw unsupported();
      return paths.resolve(canonical);
    } catch (error) {
      checkCancelled(signal);
      if (error instanceof SessionFileError) throw error;
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
        throw new SessionFileError("file_not_found", "The requested file path does not exist.");
      }
      if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) throw forbidden();
      if (hasCode(error, "ABORT_ERR") || (error instanceof Error && error.name === "AbortError")) {
        throw new SessionFileError("file_cancelled", "The file request was cancelled.");
      }
      throw new SessionFileError("file_operation_failed", "The requested file path could not be verified.");
    }
  }

  async function rulePath(rule: string): Promise<string> {
    if (rule.includes("\0")) throw unsupported();
    const input = environment.info.kind === "wsl" && !isWindowsAbsolute(rule)
      ? rule.replaceAll("\\", "/") : rule;
    let resolved: string;
    try { resolved = (await environment.paths.resolve(input, "read")).executionPath; }
    catch { throw unsupported(); }
    if (!paths.isAbsolute(resolved)) throw unsupported();
    if (environment.info.kind === "wsl" && isWindowsAbsolute(rule)) {
      const host = await verifiedHostPath(resolved);
      if (win32.resolve(host).toLowerCase() !== win32.resolve(rule).toLowerCase()) throw unsupported();
    }
    return paths.resolve(resolved);
  }

  async function verifiedHostPath(executionPath: string): Promise<string> {
    const host = environment.paths.toHostPath(executionPath);
    if (!host || !win32.isAbsolute(host)) throw unsupported();
    try {
      const roundTrip = (await environment.paths.resolve(host, "read")).executionPath;
      if (paths.resolve(roundTrip) !== paths.resolve(executionPath)) throw unsupported();
    } catch { throw unsupported(); }
    return host;
  }

  async function checkPermission(path: string, root: string, tool: FileReadTool): Promise<void> {
    const allowedTools = resolveAllowedToolNames(settings.permission.allowedTools ?? []);
    if (allowedTools.length > 0 && !allowedTools.includes(tool)) throw forbidden();
    const rules = settings.permission.pathRules ?? [];
    const useHostPaths = environment.info.kind === "wsl" && rules.some(rule => isWindowsAbsolute(rule.pattern) || rule.pattern.includes("\\"));
    if (useHostPaths && rules.some(rule => rule.pattern.startsWith("/"))) throw unsupported();
    let checker: PermissionChecker;
    let target = path;
    let cwd = root;
    if (useHostPaths) {
      for (const rule of rules) if (isWindowsAbsolute(rule.pattern)) await rulePath(rule.pattern);
      cwd = await verifiedHostPath(root);
      target = await verifiedHostPath(path);
    }
    try {
      checker = new PermissionChecker({ ...settings.permission, allowedTools, cwd,
        pathStyle: useHostPaths ? "windows" : environment.info.pathStyle });
    } catch { throw unsupported(); }
    const decision = await checker.checkTool(tool, { path: target });
    if (decision.action !== "allow") throw forbidden();
  }

  async function canonicalRule(path: string, signal?: AbortSignal): Promise<string> {
    let ancestor = path;
    for (;;) {
      try {
        const canonical = await canonicalize(ancestor, signal);
        return paths.resolve(canonical, paths.relative(ancestor, path));
      } catch (error) {
        if (!(error instanceof SessionFileError) || error.code !== "file_not_found") throw error;
        const parent = paths.dirname(ancestor);
        if (parent === ancestor) throw unsupported();
        ancestor = parent;
      }
    }
  }

  async function ruleContains(rule: string, root: string, target: string): Promise<boolean> {
    if (environment.info.kind === "wsl" && isWindowsAbsolute(rule)) {
      return contained(win32, await verifiedHostPath(root), await verifiedHostPath(target));
    }
    return contained(paths, root, target);
  }

  // The adapter obtained this name from a held file object. Never resolve it again by pathname:
  // a concurrent directory replacement could otherwise change which object is being authorized.
  async function verifyOpened(canonical: string, tool: FileReadTool, signal?: AbortSignal): Promise<void> {
    checkCancelled(signal);
    if (!canonicalRoot || !paths.isAbsolute(canonical)) throw unsupported();
    canonical = paths.resolve(canonical);
    if (!contained(paths, canonicalRoot, canonical)) throw forbidden();
    await checkPermission(canonical, canonicalRoot, tool);
    for (const rule of policy.filesystem.denyRead) {
      if (await ruleContains(rule, await canonicalRule(await rulePath(rule), signal), canonical)) throw forbidden();
    }
    if (policy.enabled) {
      let allowed = false;
      for (const rule of [...policy.filesystem.allowRead, ...policy.filesystem.extraAllowedRoots]) {
        if (await ruleContains(rule, await canonicalRule(await rulePath(rule), signal), canonical)) { allowed = true; break; }
      }
      if (!allowed) throw forbidden();
    }
    checkCancelled(signal);
  }

  return {
    verifyOpened,
    async authorize(relativePath: string, tool: FileReadTool, signal?: AbortSignal): Promise<AuthorizedFilePath> {
      checkCancelled(signal);
      const relative = validateRelativePath(relativePath, environment.info.pathStyle);
      if (!paths.isAbsolute(environment.workspace.executionRoot)) throw unsupported();
      const root = paths.resolve(environment.workspace.executionRoot);
      let target: string;
      try { target = paths.resolve((await environment.paths.resolve(relative, "read")).executionPath); }
      catch { throw unsupported(); }
      checkCancelled(signal);
      if (!contained(paths, root, target)) throw forbidden();
      await checkPermission(target, root, tool);
      checkCancelled(signal);

      const denies = await Promise.all(policy.filesystem.denyRead.map(async rule => ({ rule, path: await rulePath(rule) })));
      for (const denied of denies) if (await ruleContains(denied.rule, denied.path, target)) throw forbidden();
      checkCancelled(signal);
      canonicalRoot ??= await canonicalize(root, signal);
      const canonical = await canonicalize(target, signal);
      await verifyOpened(canonical, tool, signal);
      return { executionPath: canonical, sourcePath: target, relativePath: relative };
    },
  };
}

function validateRelativePath(path: string, style: "windows" | "posix"): string {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || path.includes("\\")
    || path.startsWith("/") || /^[a-zA-Z]:\//.test(path) || path.split("/").includes("..")
    || (style === "windows" && path.includes(":"))) {
    throw new SessionFileError("file_invalid_request", "Provide a workspace-relative path using forward slashes.");
  }
  return posix.normalize(path).replace(/\/$/, "") || ".";
}

function contained(paths: typeof posix | typeof win32, root: string, path: string): boolean {
  const relative = paths.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

function isWindowsAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SessionFileError("file_cancelled", "The file request was cancelled.");
}
