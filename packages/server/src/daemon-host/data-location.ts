import { open, readFile, realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDataDir, writeJsonFileAtomically } from "@vykor/host-config";
import { getDataRoot, isCompleteAbsolutePath } from "@vykor/host-config/paths";
import { ApplicationError } from "../shared/application-error.js";

export interface RegisteredDataLocation {
  directory: string;
  storePath: string;
}

export interface DataSwitchResult {
  id: string;
  status: "pending" | "succeeded" | "failed" | "interrupted" | "rollback_failed";
  error?: string;
  rollbackError?: string;
}

export interface DataLocationState {
  version: 1;
  location: RegisteredDataLocation;
  result?: DataSwitchResult;
}

export function dataLocationFile(baseDataDirectory: string): string {
  return join(baseDataDirectory, "daemon", "data-location.json");
}

export function defaultDataLocation(directory: string): RegisteredDataLocation {
  return { directory, storePath: join(directory, "session-runtime", "sessions.db") };
}

export async function readDataLocationState(path: string): Promise<DataLocationState | undefined> {
  const saved = await readJson(path);
  return parseDataLocationState(saved, path);
}

function parseDataLocationState(saved: unknown, path: string): DataLocationState | undefined {
  if (saved === undefined) return undefined;
  const value = saved as Partial<DataLocationState> | null;
  const location = value?.version === 1 && parseLocation(value.location);
  if (!location) throw new Error(`Invalid daemon data location: ${path}`);
  return { version: 1, location, ...(value?.result ? { result: value.result } : {}) };
}

export function legacyDesktopDataLocation(): string | undefined {
  if (getDataRoot() !== join(homedir(), ".vykor") || process.env.VYKOR_DATA_DIR) return undefined;
  const profile = process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(profile, "Vykor", "runtime-data-location.json");
}

/** All default application entries must reject old selections before constructing a Store. */
export function assertCanonicalDataLocation(): void {
  const directory = getDataDir(), canonical = defaultDataLocation(directory);
  for (const path of [dataLocationFile(directory), legacyDesktopDataLocation()]) {
    if (!path) continue;
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const selected = parseDataLocationState(JSON.parse(text), path)!.location;
    if (relative(canonical.directory, selected.directory) || relative(canonical.storePath, selected.storePath))
      throw new Error("旧数据位置需要通过 data-root migrate 导入；不会创建另一份空数据库。");
    // The current root record takes precedence over retained Desktop legacy data.
    return;
  }
}

export async function readLegacyDataLocation(path?: string): Promise<RegisteredDataLocation | undefined> {
  if (!path) return undefined;
  return (await readDataLocationState(path))?.location;
}

export async function readRegisteredDataLocation(
  baseDataDirectory?: string,
  legacyDataLocationPath?: string,
): Promise<RegisteredDataLocation | undefined> {
  if (baseDataDirectory === undefined) return defaultDataLocation(getDataDir());
  const saved = await readDataLocationState(dataLocationFile(baseDataDirectory));
  return saved?.location ?? await readLegacyDataLocation(legacyDataLocationPath);
}

export async function readRegisteredDataSwitchResult(id: string): Promise<DataSwitchResult | undefined> {
  const saved = await readDataLocationState(dataLocationFile(getDataDir()));
  return saved?.result?.id === id ? saved.result : undefined;
}

export async function saveDataLocationState(path: string, state: DataLocationState): Promise<void> {
  await writeJsonFileAtomically(path, state);
}

function parseLocation(value: unknown): RegisteredDataLocation | undefined {
  if (!value || typeof value !== "object" || !("directory" in value) ||
    !isCompleteAbsolutePath(value.directory)) return undefined;
  const directory = resolve(value.directory);
  const storePath = "storePath" in value ? value.storePath : undefined;
  if (storePath === undefined) return defaultDataLocation(directory);
  if (!isCompleteAbsolutePath(storePath)) return undefined;
  return { directory, storePath: resolve(storePath) };
}

async function readJson(path: string): Promise<DataLocationState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DataLocationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid daemon data location: ${path}`);
  }
}

export async function validateSwitchLocation(input: RegisteredDataLocation): Promise<RegisteredDataLocation> {
  const requested = parseLocation(input);
  if (!requested) throw new ApplicationError(400, "数据目录和数据库必须是完整路径。");
  try {
    const [directory, storePath] = await Promise.all([
      realpath(requested.directory),
      realpath(requested.storePath),
    ]);
    const offset = relative(directory, storePath);
    if (!offset || offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset) ||
      !(await stat(storePath)).isFile()) {
      throw new Error("数据库必须位于所选数据目录内。");
    }
    const database = await open(storePath, "r");
    try {
      const header = Buffer.alloc(16);
      await database.read(header, 0, header.length, 0);
      if (header.toString("ascii") !== "SQLite format 3\0") throw new Error("数据库格式无效。");
    } finally {
      await database.close();
    }
    return { directory, storePath };
  } catch (error) {
    throw new ApplicationError(400, `无法校验目标数据库：${error instanceof Error ? error.message : String(error)}`);
  }
}
