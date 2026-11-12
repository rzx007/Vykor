import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { ManagedPathMove } from "./managed-path-map.js";

const windowsAbsolute = (value: string) => /^(?:[a-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value);

/** Native absolute paths must not depend on the process's current drive. */
export function isCompleteAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    && (process.platform === "win32" ? windowsAbsolute(value) : isAbsolute(value));
}

export function requireCompleteAbsolutePath(value: string, source: string): string {
  if (!isCompleteAbsolutePath(value)) throw new Error(`${source} must be a complete absolute path: ${JSON.stringify(value)}`);
  return resolve(value);
}

/** Cross-platform comparison for saved paths; does not grant filesystem access. */
export function isWithinManagedPath(path: string, root: string): boolean {
  if (windowsAbsolute(path) !== windowsAbsolute(root)) return false;
  const flavor = windowsAbsolute(root) ? win32 : posix;
  if (!flavor.isAbsolute(root) || !flavor.isAbsolute(path)) return false;
  const offset = flavor.relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(offset));
}

export function relocateManagedPath(path: string, moves: readonly ManagedPathMove[]): string {
  const move = moves.filter(item => isWithinManagedPath(path, item.from))
    .sort((a, b) => b.from.length - a.from.length)[0];
  if (!move) return path;
  const flavor = windowsAbsolute(move.from) ? win32 : posix;
  return flavor.join(move.to, flavor.relative(move.from, path));
}

/** Resolve missing descendants through their nearest existing ancestor, without mkdir. */
export async function resolveManagedRealPath(path: string): Promise<string> {
  path = requireCompleteAbsolutePath(path, "managed path");
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await resolveManagedRealPath(parent), basename(path));
  }
}

export async function assertManagedPathBoundary(path: string, scope: string): Promise<void> {
  requireCompleteAbsolutePath(path, "managed path");
  requireCompleteAbsolutePath(scope, "managed scope");
  if (!isWithinManagedPath(path, scope) || !isWithinManagedPath(await resolveManagedRealPath(path), await resolveManagedRealPath(scope)))
    throw new Error(`Managed path escapes outside its scope: ${path} (${scope})`);
}
