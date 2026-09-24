import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getInstalledPluginStorePath } from "@vykor/core";

export type NativePluginInstallScope = "user" | "managed";
export interface InstalledPluginRecord {
  id: string;
  scope: NativePluginInstallScope;
  enabled: boolean;
  currentVersion: string;
  cachePath: string;
  behaviorDigest?: string;
  linkedSourcePath?: string;
  origin: "native" | "converted";
  sourceFormat?: string;
  requestedPermissions: string[];
  approvedPermissions: string[];
  installedAt: string;
  updatedAt: string;
}
export interface InstalledPluginStoreV1 {
  schemaVersion: 1;
  revision: number;
  plugins: Record<string, InstalledPluginRecord>;
}

export function installedPluginKey(record: Pick<InstalledPluginRecord, "id" | "scope">): string {
  return `${record.scope}::${record.id}`;
}

export async function readInstalledPluginStore(path: string): Promise<InstalledPluginStoreV1> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, revision: 0, plugins: {} };
    throw error;
  }
  if (raw === null || typeof raw !== "object" || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error("Unsupported installed plugin store schema version");
  }
  const store = raw as InstalledPluginStoreV1;
  if (!Number.isInteger(store.revision) || store.revision < 0 || !store.plugins || typeof store.plugins !== "object") {
    throw new Error("Invalid installed plugin store");
  }
  if (Object.values(store.plugins).some((record) =>
    !record || typeof record !== "object" || (record.scope !== "user" && record.scope !== "managed")
  )) {
    throw new Error("Invalid installed plugin store");
  }
  return store;
}

export async function updateInstalledPluginStore(
  path: string,
  mutate: (store: InstalledPluginStoreV1) => void | Promise<void>,
): Promise<InstalledPluginStoreV1> {
  const current = await readInstalledPluginStore(path);
  const next = structuredClone(current);
  await mutate(next);
  next.revision = current.revision + 1;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return next;
}

export async function discoverInstalledNativePlugins(input: {
  cwd: string;
  storePath?: string;
}): Promise<InstalledPluginRecord[]> {
  const store = await readInstalledPluginStore(input.storePath ?? getInstalledPluginStorePath());
  return Object.values(store.plugins).filter((record) => record.enabled);
}
