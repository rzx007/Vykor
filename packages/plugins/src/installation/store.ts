import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { MarketplaceOperation, MarketplaceProvenance } from "@vykor/plugin-contracts/marketplace";
import { getInstalledPluginStorePath } from "@vykor/host-config";

export type NativePluginInstallScope = "user" | "managed";
export interface InstalledPluginRecord {
  provenance?: MarketplaceProvenance;
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
  installOperations?: Record<string, StoredPluginInstallOperation>;
  schemaVersion: 1;
  revision: number;
  plugins: Record<string, InstalledPluginRecord>;
}
export interface StoredPluginInstallOperation extends MarketplaceOperation { fingerprint: string; updatedAt: string }
const writeQueues = new Map<string, Promise<unknown>>();
const installationQueues = new Map<string, Promise<unknown>>();
function queued<T>(queues: Map<string, Promise<unknown>>, path: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, pending);
  void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => {});
  return pending;
}
/** Serializes install decisions without closing any running session or app. */
export function withPluginInstallationLock<T>(path: string, operation: () => Promise<T>): Promise<T> { return queued(installationQueues, path, operation); }
export function prunePluginInstallOperations(store: InstalledPluginStoreV1, now = Date.now()): void {
  const entries = Object.entries(store.installOperations ?? {}).sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt));
  store.installOperations = Object.fromEntries(entries.filter(([, item]) => item.status === "pending" || now - Date.parse(item.updatedAt) < 7 * 86400_000).slice(0, 1000));
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
  return queued(writeQueues, path, () => writeInstalledPluginStore(path, mutate));
}
async function writeInstalledPluginStore(path: string, mutate: (store: InstalledPluginStoreV1) => void | Promise<void>): Promise<InstalledPluginStoreV1> {
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
