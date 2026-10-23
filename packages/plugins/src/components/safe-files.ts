import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { resolveNativePluginPath } from "../installation/paths.js";

export class PluginFileReadError extends Error {
  constructor(readonly reason: "invalid" | "too_large") { super(`Plugin file ${reason}`); }
}

/** Read a bounded ordinary file without accepting in-root symlinks or junctions. */
export async function readPluginFileBytes(
  root: string,
  declaredPath: string,
  limit: number,
): Promise<{ path: string; bytes: Buffer }> {
  const realRoot = await realpath(root);
  const path = await resolveNativePluginPath(realRoot, declaredPath);
  const lexicalPath = resolve(realRoot, declaredPath);
  let parent = realRoot;
  for (const segment of relative(realRoot, lexicalPath).split(sep)) {
    parent = join(parent, segment);
    if ((await lstat(parent)).isSymbolicLink())
      throw new PluginFileReadError("invalid");
  }
  const target = await lstat(path);
  if (!target.isFile()) throw new PluginFileReadError("invalid");
  if (target.size > limit) throw new PluginFileReadError("too_large");
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.dev !== target.dev ||
      before.ino !== target.ino
    ) {
      throw new PluginFileReadError("invalid");
    }
    if (before.size > limit)
      throw new PluginFileReadError("too_large");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new PluginFileReadError("too_large");
    const after = await file.stat();
    const current = await lstat(path);
    if (
      size !== after.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !current.isFile() ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      (await realpath(lexicalPath)) !== path
    ) {
      throw new PluginFileReadError("invalid");
    }
    const bytes = buffer.subarray(0, size);
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path, bytes };
  } finally {
    await file.close();
  }
}
