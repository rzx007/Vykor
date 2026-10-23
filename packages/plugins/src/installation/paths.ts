import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";

export type NativePluginPathErrorCode =
  | "invalid_declared_path"
  | "path_outside_root"
  | "root_unavailable";

export class NativePluginPathError extends Error {
  constructor(
    public readonly code: NativePluginPathErrorCode,
    message: string,
    public readonly declaredPath: string,
  ) {
    super(message);
    this.name = "NativePluginPathError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${win32.sep}`) &&
      !difference.startsWith(`..${posix.sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference) &&
      !win32.isAbsolute(difference))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 解析 Native manifest 中的相对路径，并同时校验 lexical path 与 symlink 后的真实路径。
 * 不存在的生成目标会从最近存在的父目录继续做真实路径边界检查。
 */
export async function resolveNativePluginPath(root: string, declaredPath: string): Promise<string> {
  if (
    !declaredPath.startsWith("./") ||
    isAbsolute(declaredPath) ||
    win32.isAbsolute(declaredPath) ||
    declaredPath.startsWith("//") ||
    declaredPath.startsWith("\\\\")
  ) {
    throw new NativePluginPathError(
      "invalid_declared_path",
      `Native component path must start with ./ and be relative: ${declaredPath}`,
      declaredPath,
    );
  }

  let realRoot: string;
  try {
    realRoot = await realpath(resolve(root));
  } catch (error) {
    throw new NativePluginPathError(
      "root_unavailable",
      `Native plugin root is unavailable: ${String(error)}`,
      declaredPath,
    );
  }

  const lexicalTarget = resolve(realRoot, declaredPath);
  if (!isWithin(realRoot, lexicalTarget)) {
    throw new NativePluginPathError(
      "path_outside_root",
      `Native component path leaves the plugin root: ${declaredPath}`,
      declaredPath,
    );
  }

  if (await exists(lexicalTarget)) {
    const realTarget = await realpath(lexicalTarget);
    if (!isWithin(realRoot, realTarget)) {
      throw new NativePluginPathError(
        "path_outside_root",
        `Native component symlink leaves the plugin root: ${declaredPath}`,
        declaredPath,
      );
    }
    return realTarget;
  }

  const missingSegments: string[] = [];
  let ancestor = lexicalTarget;
  while (!(await exists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new NativePluginPathError(
        "root_unavailable",
        `Cannot find an existing parent for Native component path: ${declaredPath}`,
        declaredPath,
      );
    }
    missingSegments.unshift(basename(ancestor));
    ancestor = parent;
  }

  const realAncestor = await realpath(ancestor);
  if (!isWithin(realRoot, realAncestor)) {
    throw new NativePluginPathError(
      "path_outside_root",
      `Native component parent symlink leaves the plugin root: ${declaredPath}`,
      declaredPath,
    );
  }
  return join(realAncestor, ...missingSegments);
}
