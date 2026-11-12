import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type RootEnvironment = Record<string, string | undefined>;
export interface DataRootSelection {
  dataRoot: string;
  source: "explicit" | "environment" | "selector" | "default";
}
export interface DataRootSelector {
  version: 1;
  dataRoot: string;
  pendingMigration?: { id: string; journalPath: string };
}
export interface DataRootSelectionInput {
  explicitRoot?: string;
  env?: RootEnvironment;
  homeDir?: string;
}

let initializedSelection: DataRootSelection | undefined;

function absoluteRoot(value: string, source: string): string {
  if (!value.trim() || !isAbsolute(value)) throw new Error(`${source} must be a non-empty absolute data root: ${JSON.stringify(value)}`);
  return resolve(value);
}

/** Pure selection: no disk access, mutation, or directory creation. */
export function selectDataRoot(input: {
  explicitRoot?: string; env: RootEnvironment; homeDir: string; selector?: DataRootSelector;
}): DataRootSelection {
  // Validate both product inputs even when one would shadow the other.
  const explicit = input.explicitRoot === undefined ? undefined : absoluteRoot(input.explicitRoot, "--data-root / explicitRoot");
  const environment = input.env.VYKOR_CONFIG_DIR === undefined ? undefined : absoluteRoot(input.env.VYKOR_CONFIG_DIR, "VYKOR_CONFIG_DIR");
  if (explicit !== undefined) return { dataRoot: explicit, source: "explicit" };
  if (environment !== undefined) return { dataRoot: environment, source: "environment" };
  if (input.selector) return { dataRoot: absoluteRoot(input.selector.dataRoot, ".vykor-root.json dataRoot"), source: "selector" };
  return { dataRoot: join(input.homeDir, ".vykor"), source: "default" };
}

/** Explicit env callers must not accidentally consult process.env for their home. */
export function dataRootHome(env: RootEnvironment = process.env): string {
  return env.USERPROFILE ?? env.HOME ?? homedir();
}

export function dataRootSelectorPath(homeDir: string): string { return join(homeDir, ".vykor-root.json"); }
export function movedDataRootMarkerPath(dataRoot: string): string { return join(dataRoot, "data", "migrations", "moved-root.json"); }

function validateSelector(value: unknown, file: string): DataRootSelector {
  const invalid = () => new Error(`Invalid data root selector ${file}; inspect this file and run data-root recover before starting.`);
  if (!value || typeof value !== "object") throw invalid();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.dataRoot !== "string" || !record.dataRoot.trim() || !isAbsolute(record.dataRoot)) throw invalid();
  let pendingMigration: DataRootSelector["pendingMigration"];
  if (record.pendingMigration !== undefined) {
    const pending = record.pendingMigration as Record<string, unknown> | null;
    if (!pending || typeof pending.id !== "string" || !pending.id.trim()
      || typeof pending.journalPath !== "string" || !isAbsolute(pending.journalPath)) throw invalid();
    pendingMigration = { id: pending.id, journalPath: pending.journalPath };
  }
  return { version: 1, dataRoot: resolve(record.dataRoot), ...(pendingMigration ? { pendingMigration } : {}) };
}

/** Maintenance commands may read this without applying normal startup guards. */
export function readDataRootSelector(homeDir: string): DataRootSelector | undefined {
  const file = dataRootSelectorPath(homeDir);
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Invalid data root selector ${file}; inspect this file and run data-root recover before starting.`); }
  return validateSelector(value, file);
}

/** Read-only startup/discovery; a recorded but unavailable root is never a fresh install. */
export function resolveDataRootSelection(input: DataRootSelectionInput = {}): DataRootSelection {
  const homeDir = input.homeDir ?? dataRootHome(input.env ?? process.env);
  if (existsSync(`${dataRootSelectorPath(homeDir)}.lock`)) throw new Error(`Data root lock is held at ${dataRootSelectorPath(homeDir)}.lock; wait for the owner or run data-root recover after verifying it has stopped.`);
  return resolveUnlockedDataRootSelection(input);
}

function resolveUnlockedDataRootSelection(input: DataRootSelectionInput): DataRootSelection {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? dataRootHome(env);
  const selector = readDataRootSelector(homeDir);
  if (selector?.pendingMigration) throw new Error(`Data root migration ${selector.pendingMigration.id} is pending (${selector.pendingMigration.journalPath}); run data-root recover before starting.`);
  const selected = selectDataRoot({ ...input, env, homeDir, selector });
  if (existsSync(movedDataRootMarkerPath(selected.dataRoot))) throw new Error(`Data root ${selected.dataRoot} has moved; inspect ${movedDataRootMarkerPath(selected.dataRoot)} and run data-root recover.`);
  if (selected.source === "selector" || selector?.dataRoot === selected.dataRoot) {
    try { if (!statSync(selected.dataRoot).isDirectory()) throw new Error("not a directory"); }
    catch { throw new Error(`Saved data root is missing or unavailable: ${selected.dataRoot}; reconnect its disk or run data-root recover. No empty root was created.`); }
  }
  assertLegacyDatabaseAvailable(join(env.VYKOR_DATA_DIR ?? join(selected.dataRoot, "data"), "daemon", "data-location.json"));
  return selected;
}

/** Until old selection is migrated, refusing a lost database prevents silent data loss. */
function assertLegacyDatabaseAvailable(file: string): void {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const value = JSON.parse(text);
    const location = value?.version === 1 && value.location;
    if (!location || typeof location.directory !== "string" || !isAbsolute(location.directory)) throw new Error("invalid location");
    const storePath = location.storePath ?? join(location.directory, "session-runtime", "sessions.db");
    if (typeof storePath !== "string" || !isAbsolute(storePath) || !statSync(storePath).isFile()) throw new Error("missing database");
  } catch { throw new Error(`Saved database is missing or its location is invalid (${file}); reconnect its disk or run data-root recover before starting.`); }
}

export interface DataRootLockState {
  pid: number;
  ownerToken: string;
  /** Unknown ownership is deliberately never treated as a dead process. */
  alive: boolean;
}

/** Recovery must verify the owner has exited; neither timestamps nor PID age prove that. */
export function readDataRootLockState(homeDir: string): DataRootLockState | undefined {
  const file = `${dataRootSelectorPath(homeDir)}.lock`;
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let value: { pid?: unknown; ownerToken?: unknown };
  try { value = JSON.parse(text); }
  catch { throw new Error(`Cannot verify data root lock owner: ${file}. Do not remove it while a startup or migration may be active.`); }
  if (!value || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.ownerToken !== "string" || !value.ownerToken)
    throw new Error(`Cannot verify data root lock owner: ${file}`);
  let alive = true;
  try { process.kill(value.pid as number, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
  return { pid: value.pid as number, ownerToken: value.ownerToken, alive };
}

export interface DataRootLock {
  /** Atomically save while holding the stable home lock; safe for migration commit. */
  writeSelector(selector: DataRootSelector): Promise<void>;
}

/** Same exclusive-create pattern as the settings lock, without settings imports or age-based stealing. */
export async function withDataRootLock<T>(homeDir: string, operation: (lock: DataRootLock) => Promise<T>, options: {
  timeoutMs?: number; pollIntervalMs?: number;
} = {}): Promise<T> {
  const file = dataRootSelectorPath(homeDir);
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let handle;
  for (;;) {
    try { handle = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Data root lock is busy: ${lockPath}; wait for the owner, or verify it has stopped and run data-root recover. Never remove an active migration lock.`);
      await sleep(options.pollIntervalMs ?? 25);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken: randomUUID() }), "utf8");
    return await operation({ writeSelector: async selector => {
      const validated = validateSelector(selector, file);
      // The fixed locator lives directly in home; never chmod or create a data root.
      if (process.platform !== "win32") await chmod(homeDir, 0o700);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const output = await open(temporary, "wx", 0o600);
        try { await output.writeFile(JSON.stringify(validated, null, 2), "utf8"); await output.sync(); }
        finally { await output.close(); }
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    } });
  } finally { await handle.close(); await rm(lockPath, { force: true }); }
}

export async function writeDataRootSelector(homeDir: string, selector: DataRootSelector): Promise<void> {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await withDataRootLock(homeDir, lock => lock.writeSelector(selector));
}

/** Must finish before importing product modules that create stores. Does not save a default selector. */
export async function initializeDataRoot(input: DataRootSelectionInput = {}): Promise<DataRootSelection> {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? dataRootHome(env);
  return withDataRootLock(homeDir, async () => {
    const selected = resolveUnlockedDataRootSelection({ ...input, env, homeDir });
    if (initializedSelection && initializedSelection.dataRoot !== selected.dataRoot) throw new Error("Data root is already initialized; restart the process to change it.");
    initializedSelection ??= Object.freeze(selected);
    env.VYKOR_CONFIG_DIR = selected.dataRoot;
    return { ...initializedSelection };
  });
}

export function currentDataRoot(): string {
  return initializedSelection?.dataRoot ?? resolveDataRootSelection().dataRoot;
}

export function getInitializedDataRootSelection(): DataRootSelection | undefined {
  return initializedSelection && { ...initializedSelection };
}

/** Consume only the host root option, before loading any command modules. */
export function parseDataRootArgument(argv: readonly string[]): { explicitRoot?: string; argv: string[] } {
  const remaining: string[] = [];
  let explicitRoot: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") { remaining.push(...argv.slice(index)); break; }
    if (arg === "--data-root" || arg.startsWith("--data-root=")) {
      if (explicitRoot !== undefined) throw new Error("--data-root may only be specified once");
      const value = arg === "--data-root" ? argv[++index] : arg.slice("--data-root=".length);
      if (value === undefined) throw new Error("--data-root requires an absolute path");
      explicitRoot = absoluteRoot(value, "--data-root");
    } else remaining.push(arg);
  }
  return { ...(explicitRoot === undefined ? {} : { explicitRoot }), argv: remaining };
}
