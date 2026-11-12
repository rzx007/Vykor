import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { securePrivateFile } from "./private-file-permissions.js";
import { isCompleteAbsolutePath, requireCompleteAbsolutePath } from "./managed-path-relocation.js";

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
export interface InitializedDataRootInputs {
  homeDir: string;
  explicitRoot?: string;
  environment: Partial<Record<"VYKOR_CONFIG_DIR" | "VYKOR_DATA_DIR" | "VYKOR_CHANNELS_DIR" | "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", string>>;
}
let initializedInputs: InitializedDataRootInputs | undefined;

function absoluteRoot(value: string, source: string): string {
  return requireCompleteAbsolutePath(value, source);
}

/** Pure selection: no disk access, mutation, or directory creation. */
export function selectDataRoot(input: {
  explicitRoot?: string; env: RootEnvironment; homeDir: string; selector?: DataRootSelector;
}): DataRootSelection {
  // Validate both product inputs even when one would shadow the other.
  const homeDir = absoluteRoot(input.homeDir, "homeDir");
  const explicit = input.explicitRoot === undefined ? undefined : absoluteRoot(input.explicitRoot, "--data-root / explicitRoot");
  const environment = input.env.VYKOR_CONFIG_DIR === undefined ? undefined : absoluteRoot(input.env.VYKOR_CONFIG_DIR, "VYKOR_CONFIG_DIR");
  if (explicit !== undefined) return { dataRoot: explicit, source: "explicit" };
  if (environment !== undefined) return { dataRoot: environment, source: "environment" };
  if (input.selector) return { dataRoot: absoluteRoot(input.selector.dataRoot, ".vykor-root.json dataRoot"), source: "selector" };
  return { dataRoot: join(homeDir, ".vykor"), source: "default" };
}

/** Explicit env callers must not accidentally consult process.env for their home. */
export function dataRootHome(env: RootEnvironment = process.env): string {
  return absoluteRoot(env.USERPROFILE ?? env.HOME ?? userInfo().homedir, "homeDir (USERPROFILE / HOME)");
}

export function dataRootSelectorPath(homeDir: string): string { return join(absoluteRoot(homeDir, "homeDir"), ".vykor-root.json"); }
export function movedDataRootMarkerPath(dataRoot: string): string { return join(dataRoot, "data", "migrations", "moved-root.json"); }

function validateSelector(value: unknown, file: string): DataRootSelector {
  const invalid = () => new Error(`Invalid data root selector ${file}; inspect this file and run data-root recover before starting.`);
  if (!value || typeof value !== "object") throw invalid();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isCompleteAbsolutePath(record.dataRoot)) throw invalid();
  let pendingMigration: DataRootSelector["pendingMigration"];
  if (record.pendingMigration !== undefined) {
    const pending = record.pendingMigration as Record<string, unknown> | null;
    if (!pending || typeof pending.id !== "string" || !pending.id.trim()
      || !isCompleteAbsolutePath(pending.journalPath)) throw invalid();
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
export class DataRootLockBusyError extends Error {
  readonly code = "data_root_locked";
  constructor(readonly lockPath: string) {
    super(`Data root lock is held at ${lockPath}; wait for the owner or run data-root recover after verifying it has stopped.`);
  }
}

export function resolveDataRootSelection(input: DataRootSelectionInput = {}): DataRootSelection {
  const homeDir = input.homeDir ?? dataRootHome(input.env ?? process.env);
  if (existsSync(`${dataRootSelectorPath(homeDir)}.lock`)) throw new DataRootLockBusyError(`${dataRootSelectorPath(homeDir)}.lock`);
  return resolveUnlockedDataRootSelection(input);
}

/** Async callers wait for ordinary startup contention within their original deadline. */
export async function waitForDataRootSelection(input: DataRootSelectionInput, options: { deadline: number; signal?: AbortSignal }): Promise<DataRootSelection> {
  for (;;) {
    options.signal?.throwIfAborted();
    if (Date.now() >= options.deadline) throw new Error("Vykor service startup timed out waiting for the data root lock.");
    try { return resolveDataRootSelection(input); }
    catch (error) { if (!(error instanceof DataRootLockBusyError)) throw error; }
    await sleep(Math.max(1, Math.min(25, options.deadline - Date.now())), undefined, { signal: options.signal });
  }
}

/** Keep saved-root identity when a missing child sits below an alias, including a dangling junction. */
function rootIdentity(path: string, links = new Set<string>()): string {
  try { return realpathSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let target: string | undefined;
  try { if (lstatSync(path).isSymbolicLink()) target = readlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (target !== undefined) {
    if (links.has(path)) throw new Error(`Cannot resolve saved data root alias ${path}; run data-root recover.`);
    links.add(path);
    return rootIdentity(resolve(dirname(path), target), links);
  }
  const parent = dirname(path);
  return parent === path ? path : join(rootIdentity(parent, links), basename(path));
}

function resolveUnlockedDataRootSelection(input: DataRootSelectionInput): DataRootSelection {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? dataRootHome(env);
  const selector = readDataRootSelector(homeDir);
  if (selector?.pendingMigration) throw new Error(`Data root migration ${selector.pendingMigration.id} is pending (${selector.pendingMigration.journalPath}); run data-root recover before starting.`);
  const selected = selectDataRoot({ ...input, env, homeDir, selector });
  if (existsSync(movedDataRootMarkerPath(selected.dataRoot))) throw new Error(`Data root ${selected.dataRoot} has moved; inspect ${movedDataRootMarkerPath(selected.dataRoot)} and run data-root recover.`);
  const restoresSavedRoot = selected.source === "selector" || (selector !== undefined &&
    (relative(selector.dataRoot, selected.dataRoot) === "" || relative(rootIdentity(selector.dataRoot), rootIdentity(selected.dataRoot)) === ""));
  if (restoresSavedRoot) {
    try { if (!statSync(selected.dataRoot).isDirectory()) throw new Error("not a directory"); }
    catch { throw new Error(`Saved data root is missing or unavailable: ${selected.dataRoot}; reconnect its disk or run data-root recover. No empty root was created.`); }
  }
  const dataDir = env.VYKOR_DATA_DIR ?? join(selected.dataRoot, "data");
  const hasLegacyLocation = assertLegacyDatabaseAvailable(join(dataDir, "daemon", "data-location.json"));
  // A saved selection restores an existing store. Only an unsaved explicit,
  // environment or default selection may initialize a genuinely new root.
  if (restoresSavedRoot && !hasLegacyLocation) assertDatabaseAvailable(join(dataDir, "session-runtime", "sessions.db"));
  return selected;
}

/** Until old selection is migrated, refusing a lost database prevents silent data loss. */
function assertDatabaseAvailable(file: string): void {
  try { const info = statSync(file); if (!info.isFile() || info.size === 0) throw new Error("not an existing database"); }
  catch { throw new Error(`Saved database is missing, empty or unavailable (${file}); reconnect its disk or run data-root recover. No empty database was created.`); }
}

function assertLegacyDatabaseAvailable(file: string): boolean {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const value = JSON.parse(text);
    const location = value?.version === 1 && value.location;
    if (!location || !isCompleteAbsolutePath(location.directory)) throw new Error("invalid location");
    const storePath = location.storePath ?? join(location.directory, "session-runtime", "sessions.db");
    if (!isCompleteAbsolutePath(storePath)) throw new Error("invalid database path");
    const info = statSync(storePath);
    if (!info.isFile() || info.size === 0) throw new Error("missing or empty database");
  } catch { throw new Error(`Saved database is missing, empty or its location is invalid (${file}); reconnect its disk or run data-root recover before starting.`); }
  return true;
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
    await securePrivateFile(lockPath);
    await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken: randomUUID() }), "utf8");
    return await operation({ writeSelector: async selector => {
      const validated = validateSelector(selector, file);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const output = await open(temporary, "wx", 0o600);
        try { await securePrivateFile(temporary); await output.writeFile(JSON.stringify(validated, null, 2), "utf8"); await output.sync(); }
        finally { await output.close(); }
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    } });
  } finally { await handle.close(); await rm(lockPath, { force: true }); }
}

export async function writeDataRootSelector(homeDir: string, selector: DataRootSelector): Promise<void> {
  validateSelector(selector, dataRootSelectorPath(homeDir));
  await withDataRootLock(homeDir, lock => lock.writeSelector(selector));
}

/** Must finish before importing product modules that create stores. Does not save a default selector. */
export async function initializeDataRoot(input: DataRootSelectionInput = {}): Promise<DataRootSelection> {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? dataRootHome(env);
  selectDataRoot({ ...input, env, homeDir }); // Validate before even creating the stable lock.
  readDataRootSelector(homeDir); // Reject malformed saved paths before the lock; reread under it for races.
  return withDataRootLock(homeDir, async () => {
    const selected = resolveUnlockedDataRootSelection({ ...input, env, homeDir });
    if (initializedSelection && initializedSelection.dataRoot !== selected.dataRoot) throw new Error("Data root is already initialized; restart the process to change it.");
    initializedSelection ??= Object.freeze(selected);
    initializedInputs ??= {
      homeDir: absoluteRoot(homeDir, "homeDir"),
      ...(input.explicitRoot !== undefined ? { explicitRoot: input.explicitRoot } : {}),
      environment: Object.fromEntries(["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"]
        .flatMap(key => env[key] === undefined ? [] : [[key, env[key]]])),
    };
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

/** Original host inputs only: never captures credentials or the internally injected root. */
export function getInitializedDataRootInputs(): InitializedDataRootInputs | undefined {
  return initializedInputs && { ...initializedInputs, environment: { ...initializedInputs.environment } };
}

/** Only the leading host option is unambiguous without parsing command-specific values. */
export function parseDataRootArgument(argv: readonly string[]): { explicitRoot?: string; argv: string[] } {
  const first = argv[0];
  if (first !== "--data-root" && !first?.startsWith("--data-root=")) return { argv: [...argv] };
  const value = first === "--data-root" ? argv[1] : first.slice("--data-root=".length);
  if (value === undefined) throw new Error("--data-root requires an absolute path as the first option");
  return { explicitRoot: absoluteRoot(value, "--data-root"), argv: argv.slice(first === "--data-root" ? 2 : 1) };
}
