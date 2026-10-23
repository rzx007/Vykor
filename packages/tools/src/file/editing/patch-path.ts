export type PatchPathStyle = "windows" | "posix";

export const PATCH_DEV_NULL = "/dev/null";

export function isDevNullPath(raw: string): boolean {
  return raw === PATCH_DEV_NULL;
}

/**
 * 把 unified diff 里的文件路径规范成 workspace 相对路径。
 *
 * 只做项目特有的安全检查，不解析 rename/copy 或符号链接：
 * 去掉一个标准的 `a/` 或 `b/` 前缀，拒绝空路径、NUL、反斜杠、绝对路径、
 * 盘符、UNC、重复/空路径段和任何 `..` 段。`/dev/null` 由操作分类器处理。
 */
export function normalizePatchPath(raw: string, _style: PatchPathStyle): string {
  if (raw.length === 0) throw new Error("Patch path must not be empty");
  if (raw.includes("\u0000")) throw new Error(`Patch path contains NUL: ${raw}`);
  if (raw.includes("\\")) throw new Error(`Patch path must use POSIX separators: ${raw}`);

  const path = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;

  if (path.length === 0) throw new Error(`Patch path is empty after prefix: ${raw}`);
  if (path.startsWith("/")) throw new Error(`Patch path must be relative: ${raw}`);
  if (/^[a-zA-Z]:/.test(path)) throw new Error(`Patch path must not contain a drive letter: ${raw}`);

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Patch path contains an empty segment: ${raw}`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Patch path must not contain '.' or '..': ${raw}`);
  }
  return path;
}

/** 按执行环境判断路径身份：Windows 折叠大小写，POSIX/WSL 保持大小写敏感。 */
export function patchPathIdentity(path: string, style: PatchPathStyle): string {
  if (style !== "windows") return path;
  return path.replace(/\\/g, "/").toLowerCase();
}
