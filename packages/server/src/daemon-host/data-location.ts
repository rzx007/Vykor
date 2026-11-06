import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDataDir, writeJsonFileAtomically } from "@vykor/host-config";
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
  if (saved === undefined) return undefined;
  const location = saved?.version === 1 && parseLocation(saved.location);
  if (!location) throw new Error(`Invalid daemon data location: ${path}`);
  return { version: 1, location, ...(saved.result ? { result: saved.result } : {}) };
}

export async function readLegacyDataLocation(path?: string): Promise<RegisteredDataLocation | undefined> {
  if (!path) return undefined;
  const saved = await readJson(path);
  return saved?.version === 1 ? parseLocation(saved.location) : undefined;
}

export async function readRegisteredDataLocation(
  baseDataDirectory = getDataDir(),
  legacyDataLocationPath?: string,
): Promise<RegisteredDataLocation | undefined> {
  const saved = await readDataLocationState(dataLocationFile(baseDataDirectory));
  return saved?.location ?? await readLegacyDataLocation(legacyDataLocationPath);
}

export async function saveDataLocationState(path: string, state: DataLocationState): Promise<void> {
  await writeJsonFileAtomically(path, state);
}

function parseLocation(value: unknown): RegisteredDataLocation | undefined {
  if (!value || typeof value !== "object" || !("directory" in value) ||
    typeof value.directory !== "string" || !isAbsolute(value.directory)) return undefined;
  const directory = resolve(value.directory);
  const storePath = "storePath" in value ? value.storePath : undefined;
  if (storePath === undefined) return defaultDataLocation(directory);
  if (typeof storePath !== "string" || !isAbsolute(storePath)) return undefined;
  return { directory, storePath: resolve(storePath) };
}

async function readJson(path: string): Promise<DataLocationState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DataLocationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
