import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { assertManagedPathBoundary, isWithinManagedPath, relocateManagedPath, type ManagedPathMove, type PathRelocationReport } from "@vykor/host-config/paths";
import { readInstalledPluginStore } from "./store.js";
import { verifyInstalledNativePlugin } from "./verify.js";

/** Only the owned store is written. Stored references are final; validation reads staged bytes. */
export async function relocateInstalledPluginStore(
  storePath: string,
  moves: readonly ManagedPathMove[],
  physical?: { stagedRoot: string; targetRoot: string },
): Promise<PathRelocationReport> {
  const result: PathRelocationReport = { changed: 0, unchangedExternal: 0, unsupported: [] };
  const stat = await lstat(storePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Plugin store copy must be a regular file");
  if (physical) await assertManagedPathBoundary(storePath, physical.stagedRoot);
  const store = await readInstalledPluginStore(storePath);
  for (const record of Object.values(store.plugins)) {
    if (typeof record.cachePath !== "string") throw new Error("Invalid plugin cache path");
    const next = record.linkedSourcePath ? record.cachePath : relocateManagedPath(record.cachePath, moves);
    const cachePath = physical && isWithinManagedPath(next, physical.targetRoot)
      ? relocateManagedPath(next, [{ kind: "user-root", from: physical.targetRoot, to: physical.stagedRoot }]) : next;
    if (physical && cachePath !== next) await assertManagedPathBoundary(cachePath, physical.stagedRoot);
    const verified = await verifyInstalledNativePlugin({ ...record, cachePath });
    if (verified.status !== "valid") throw new Error(`Plugin relocation validation failed: ${record.id}: ${verified.diagnostics.map(item => item.code).join(",")}`);
    if (next !== record.cachePath) { record.cachePath = next; result.changed++; }
    else result.unchangedExternal++;
  }
  if (!result.changed) return result;
  const temporary = `${storePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx", mode: stat.mode });
    await rename(temporary, storePath);
  } finally { await rm(temporary, { force: true }); }
  return result;
}
