import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { getDataRoot, resolveUserDataPaths } from "./paths.js";
import { assertManagedPathBoundary, isCompleteAbsolutePath, isWithinManagedPath, relocateManagedPath, resolveManagedRealPath } from "./managed-path-relocation.js";

export interface ManagedPathMove {
  kind: "user-root" | "runtime-data" | "workspace" | "channel" | "worktree";
  from: string;
  to: string;
}
export interface ManagedPathMap {
  version: 1;
  moves: ManagedPathMove[];
  excludedRoots?: string[];
}

/** Read historical locations for identification; this map never grants file access. */
export function readManagedPathMap(dataRoot: string = getDataRoot()): ManagedPathMap {
  const file = resolveUserDataPaths(dataRoot).pathMapFilePath;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, moves: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error(`Invalid managed path-map: ${file}`); }
  const map = value as Partial<ManagedPathMap> | null;
  if (!map || map.version !== 1 || !Array.isArray(map.moves) ||
    !map.moves.every(move => move && ["user-root", "runtime-data", "workspace", "channel", "worktree"].includes(move.kind) && absolutePath(move.from) && absolutePath(move.to)) ||
    (map.excludedRoots !== undefined && (!Array.isArray(map.excludedRoots) || !map.excludedRoots.every(absolutePath)))) {
    throw new Error(`Invalid managed path-map: ${file}`);
  }
  return map as ManagedPathMap;
}

/** Resolve a saved native path before the caller's existing access checks; never adds allowed roots. */
export async function resolveManagedHistoryPath(path: string, dataRoot: string = getDataRoot()): Promise<string> {
  if (!isCompleteAbsolutePath(path)) return path;
  const map = readManagedPathMap(dataRoot);
  if (map.excludedRoots?.some(root => isWithinManagedPath(path, root))) return path;
  const move = map.moves.filter(move => isWithinManagedPath(path, move.from)).sort((a, b) => b.from.length - a.from.length)[0];
  if (!move) return path;
  const next = relocateManagedPath(path, [move]);
  const originalScope = await resolveManagedRealPath(move.from);
  if (!isWithinManagedPath(originalScope, move.from) || !isWithinManagedPath(move.from, originalScope)) throw new Error("Managed history source escapes its recorded scope");
  await assertManagedPathBoundary(path, move.from);
  await assertManagedPathBoundary(move.to, dataRoot);
  await assertManagedPathBoundary(next, move.to);
  // A mapping destination replaced by a link must not become a new authorization scope.
  if (!isWithinManagedPath(await resolveManagedRealPath(next), move.to)) throw new Error("Managed history path escapes its mapped scope");
  return next;
}

export function getManagedWorkspaceRoots(dataRoot: string = getDataRoot()): string[] {
  return workspaceRoots(dataRoot, readManagedPathMap(dataRoot));
}

export function isManagedWorkspacePath(path: string, dataRoot: string = getDataRoot()): boolean {
  return getManagedWorkspaceRoots(dataRoot).some(root => isWithin(path, root));
}

/** Staging/retained roots are hidden but never added to file access roots. */
export function isHiddenManagedProjectPath(path: string, dataRoot: string = getDataRoot()): boolean {
  const map = readManagedPathMap(dataRoot);
  return [...workspaceRoots(dataRoot, map), ...(map.excludedRoots ?? [])].some(root => isWithin(path, root));
}

function workspaceRoots(dataRoot: string, map: ManagedPathMap): string[] {
  const paths = resolveUserDataPaths(dataRoot);
  return [...new Set([paths.workspacesDir, paths.channelsDir, ...map.moves.flatMap(move =>
    move.kind === "workspace" || move.kind === "channel" ? [move.from, move.to] : [])])];
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && (posix.isAbsolute(value) || isWindowsPath(value));
}

function isWithin(path: string, root: string): boolean {
  if (isWindowsPath(path) !== isWindowsPath(root)) return false;
  const flavor = isWindowsPath(root) ? win32 : posix;
  const relative = flavor.relative(flavor.resolve(root), flavor.resolve(path));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative));
}

function isWindowsPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(path);
}
