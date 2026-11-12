import { readFileSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { getDataRoot, resolveUserDataPaths } from "./paths.js";

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
  return typeof value === "string" && (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value));
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
