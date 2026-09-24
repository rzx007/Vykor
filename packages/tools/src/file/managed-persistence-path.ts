import { isAbsolute, normalize, relative, resolve } from "node:path";
import { getConfigDir, getProjectMemoryDir } from "@vykor/core";

export type ManagedPersistencePathKind = "user-profile" | "project-memory";

export function managedPersistencePathKind(
  filePath: string,
  cwd: string,
): ManagedPersistencePathKind | null {
  const target = normalizePath(resolve(filePath));
  const userProfile = normalizePath(resolve(getConfigDir(), "USER.md"));
  if (target === userProfile) return "user-profile";

  const memoryDir = normalizePath(resolve(getProjectMemoryDir(cwd)));
  const fromMemoryDir = relative(memoryDir, target);
  if (
    fromMemoryDir === "" ||
    (!fromMemoryDir.startsWith("..") && !isAbsolute(fromMemoryDir))
  ) {
    return "project-memory";
  }

  return null;
}

function normalizePath(path: string): string {
  if (process.platform !== "win32") return path;
  const withoutDevicePrefix = path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "");
  return normalize(withoutDevicePrefix).toLowerCase();
}
