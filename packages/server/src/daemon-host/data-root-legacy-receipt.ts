import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCompleteAbsolutePath, resolveManagedRealPath, resolveUserDataPaths } from "@vykor/host-config/paths";
import { readLegacyDataLocation, dataLocationFile } from "./data-location.js";
import type { DataRootMigrationPreview, DataRootMigrationRequest } from "./data-root-sources.js";

const keys = ["VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"] as const;
type LegacyDirectoryKey = typeof keys[number];
export interface LegacyDesktopSourceReceipt {
  version: 1; status: "pending" | "consumed";
  sourceRoot: string; sourceIdentity: string; userDataDir: string; documentsDir: string;
  environment: Partial<Record<LegacyDirectoryKey, string>>;
  identities: Array<{ path: string; identity: string }>;
  databasePath?: string;
}
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }); }
async function identity(path: string): Promise<string> {
  const value = await lstat(path);
  if ((!value.isFile() && !value.isDirectory()) || value.isSymbolicLink() || !same(await resolveManagedRealPath(path), path)) throw new Error("Legacy source receipt identity is unsafe");
  return `${value.dev}:${value.ino}`;
}
export async function captureLegacyDesktopSources(input: DataRootMigrationRequest, preview: DataRootMigrationPreview): Promise<LegacyDesktopSourceReceipt | undefined> {
  const paths = resolveUserDataPaths(preview.sourceRoot), environment: LegacyDesktopSourceReceipt["environment"] = {}, identities: LegacyDesktopSourceReceipt["identities"] = [];
  const defaults = { VYKOR_DATA_DIR: paths.dataDir, VYKOR_CHANNELS_DIR: paths.channelsDir, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: paths.imageAttachmentCacheDir };
  for (const key of keys) {
    const value = input.environment?.[key];
    if (!value || !await exists(value)) continue;
    const path = await resolveManagedRealPath(value);
    if (same(path, defaults[key])) continue;
    environment[key] = path; identities.push({ path, identity: await identity(path) });
  }
  const database = preview.databases.length === 1 && !same(preview.databases[0]!.path, paths.sessionsDatabasePath) ? preview.databases[0]!.path : undefined;
  if (database) identities.push({ path: database, identity: await identity(database) });
  if (!identities.length) return undefined;
  if (!input.legacy?.userDataDir || !input.legacy.documentsDir) throw new Error("Legacy export requires actual Desktop host locations");
  return { version: 1, status: "pending", sourceRoot: preview.sourceRoot, sourceIdentity: await identity(preview.sourceRoot),
    userDataDir: input.legacy.userDataDir, documentsDir: input.legacy.documentsDir, environment, identities, ...(database ? { databasePath: database } : {}) };
}

/** A prior host observation only fills absent inputs. It never changes original external pins. */
export async function restoreLegacyDesktopSources(input: DataRootMigrationRequest): Promise<DataRootMigrationRequest> {
  const explicitPaths = [input.homeDir, input.sourceRoot, input.targetRoot, input.desktopExportPath, input.legacy?.userDataDir,
    input.legacy?.documentsDir, input.legacy?.databasePath, input.legacy?.dataLocationPath, ...keys.map(key => input.environment?.[key])];
  if (explicitPaths.some(path => path !== undefined && !isCompleteAbsolutePath(path))) return input;
  const manifestPath = input.desktopExportPath ?? resolveUserDataPaths(input.sourceRoot).legacyImportFilePath;
  let manifest: any;
  try {
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024 || !same(await resolveManagedRealPath(manifestPath), manifestPath)) throw new Error("Invalid legacy source receipt file");
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return input; throw new Error("Invalid legacy source receipt file"); }
  const scan = manifest?.desktopScan, receipt = manifest?.legacySources;
  if (receipt === undefined || (record(receipt) && receipt.version === 1 && receipt.status === "consumed")) return input;
  if (!record(receipt) || receipt.version !== 1 || receipt.status !== "pending" || !isCompleteAbsolutePath(receipt.sourceRoot)
    || typeof receipt.sourceIdentity !== "string" || !isCompleteAbsolutePath(receipt.userDataDir) || !isCompleteAbsolutePath(receipt.documentsDir)
    || !record(receipt.environment) || Object.keys(receipt.environment).some(key => !keys.includes(key as LegacyDirectoryKey))
    || !Array.isArray(receipt.identities) || receipt.identities.length > 4
    || receipt.identities.some((entry: any) => !record(entry) || !isCompleteAbsolutePath(entry.path) || !/^\d+:\d+$/.test(entry.identity))
    || (receipt.databasePath !== undefined && !isCompleteAbsolutePath(receipt.databasePath))) throw new Error("Invalid legacy source receipt");
  const paths = resolveUserDataPaths(input.sourceRoot), environment = { ...input.environment }, legacy = { ...input.legacy };
  const canonicalDatabase = await exists(paths.sessionsDatabasePath);
  const locations = [dataLocationFile(paths.dataDir), ...(input.environment?.VYKOR_DATA_DIR ? [dataLocationFile(input.environment.VYKOR_DATA_DIR)] : []),
    ...(legacy.dataLocationPath ? [legacy.dataLocationPath] : []), join(legacy.userDataDir ?? scan?.userDataDir ?? receipt.userDataDir, "runtime-data-location.json")];
  let currentDatabaseSource = !!legacy.databasePath || !!environment.VYKOR_DATA_DIR;
  for (const path of locations) if (await readLegacyDataLocation(path)) currentDatabaseSource = true;
  const used: string[] = [];
  for (const key of keys) {
    const value = receipt.environment[key];
    if (value !== undefined && !isCompleteAbsolutePath(value)) throw new Error("Invalid legacy source receipt directory");
    if (environment[key] !== undefined || value === undefined || (key === "VYKOR_DATA_DIR" && (canonicalDatabase || currentDatabaseSource))) continue;
    environment[key] = value; used.push(value);
  }
  if (!canonicalDatabase && !currentDatabaseSource && receipt.databasePath) { legacy.databasePath = receipt.databasePath; used.push(receipt.databasePath); }
  if (!used.length) return input;
  if (!same(await resolveManagedRealPath(input.sourceRoot), receipt.sourceRoot) || await identity(receipt.sourceRoot) !== receipt.sourceIdentity
    || !same(receipt.userDataDir, legacy.userDataDir ?? scan?.userDataDir ?? receipt.userDataDir) || !same(receipt.documentsDir, legacy.documentsDir ?? scan?.documentsDir ?? receipt.documentsDir)
    || (scan && (!same(receipt.userDataDir, scan.userDataDir) || !same(receipt.documentsDir, scan.documentsDir)))) throw new Error("Legacy source receipt host binding changed");
  for (const path of new Set(used)) {
    const entries = receipt.identities.filter((entry: any) => same(entry.path, path));
    if (entries.length !== 1 || await identity(path) !== entries[0].identity) throw new Error("Legacy source receipt identity changed");
  }
  legacy.userDataDir ??= receipt.userDataDir;
  legacy.documentsDir ??= receipt.documentsDir;
  return { ...input, environment, legacy };
}
