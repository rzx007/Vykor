import { acquireDataRootWriter, dataRootHome, isCompleteAbsolutePath, readDataRootSelector, resolveDataRootSelection, selectDataRoot, waitForDataRootSelection } from "@vykor/host-config/paths";
import { access, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { VykorClient } from "../transport/http-client.js";
import { defaultCommand, startProcess, abandonProcess } from "./process.js";
import { pidAlive, readEndpoint, registryFile, registryFileForRoot, sameInstance, type ServiceEndpoint } from "./registry.js";
import { acquireStartupLock } from "./startup-lock.js";

export interface DiscoverServiceOptions {
  /** Explicit root-selection environment; omitted values do not fall back to another global env. */
  env?: Record<string, string | undefined>;
  /** Uses the selected user root (environment, saved selector, then ~/.vykor). */
  file?: string;
  /** Optional application version constraint, in addition to the mandatory protocol check. */
  version?: string | ((version: string) => boolean);
  signal?: AbortSignal;
  /** Probe deadline; ensure uses this as the overall startup deadline. */
  timeoutMs?: number;
}

export interface EnsureServiceOptions extends DiscoverServiceOptions {
  /** Full executable and arguments, without shell expansion. Must write the selected registry. */
  command?: readonly string[];
  /** CLI resolution and child working directory. Defaults to process.cwd(). */
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Append the detached process output to this file when starting a service. */
  logPath?: string;
}

export function clientOptions(endpoint: ServiceEndpoint): { baseUrl: string; token: string } {
  return { baseUrl: endpoint.url, token: endpoint.token };
}

function timeout(value: number | undefined, fallback: number): number {
  const milliseconds = value ?? fallback;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647)
    throw new Error("timeoutMs must be a positive integer no larger than 2147483647.");
  return milliseconds;
}

async function probe(endpoint: ServiceEndpoint, options: DiscoverServiceOptions): Promise<boolean> {
  options.signal?.throwIfAborted();
  if (!pidAlive(endpoint.pid)) return false;
  if (typeof options.version === "string" && endpoint.version !== options.version) return false;
  if (typeof options.version === "function" && !options.version(endpoint.version)) return false;
  const deadline = AbortSignal.timeout(timeout(options.timeoutMs, 1_000));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    // Each probe owns its whole client, including the normally shared handshake.
    // Bound every fetch so a timed-out capability request also releases its socket.
    const client = new VykorClient({
      ...clientOptions(endpoint),
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
    });
    const health = await client.protocol.health({ signal });
    if (!health.ok || health.ready === false || health.restartPrepared || health.version !== endpoint.version) return false;
    // This also verifies the protocol and the credential against an authenticated route.
    const sessions = await client.sessions.list({ limit: 1, signal });
    return Array.isArray(sessions);
  } catch {
    options.signal?.throwIfAborted();
    return false;
  }
}

// Only endpoints found through managed discovery carry root admission provenance.
// Explicit registry-file embedding remains caller managed, including unrelated home/env inputs.
const managedEndpoints = new WeakMap<ServiceEndpoint, { homeDir: string; dataRoot: string }>();
/** Reads and probes a local endpoint; never starts or replaces a daemon. */
export async function discover(options: DiscoverServiceOptions = {}): Promise<ServiceEndpoint | undefined> {
  options.signal?.throwIfAborted();
  timeout(options.timeoutMs, 1_000);
  const endpoint = await readEndpoint(resolve(options.file ?? registryFile(options.env)));
  if (!endpoint || !(await probe(endpoint, options))) return undefined;
  if (!sameInstance(endpoint, await readEndpoint(endpoint.file))) return undefined;
  if (!options.file) managedEndpoints.set(endpoint, { homeDir: dataRootHome(options.env ?? process.env), dataRoot: resolveDataRootSelection({ env: options.env ?? process.env }).dataRoot });
  return endpoint;
}

const startups = new Map<string, Promise<ServiceEndpoint>>();

/** Identify an existing explicit registry without admitting unrelated product-root state. */
function isManagedRegistryCandidate(file: string, env: Record<string, string | undefined>): boolean {
  if (env.VYKOR_DATA_DIR !== undefined) return file === resolve(env.VYKOR_DATA_DIR, "daemon", "registry.json");
  if (env.VYKOR_CONFIG_DIR !== undefined)
    return isCompleteAbsolutePath(env.VYKOR_CONFIG_DIR) && file === registryFileForRoot(env.VYKOR_CONFIG_DIR, env);
  let homeDir: string;
  try { homeDir = dataRootHome(env); }
  catch { return false; } // An invalid unrelated home cannot establish managed provenance.
  const fallback = selectDataRoot({ env, homeDir });
  let selector: ReturnType<typeof readDataRootSelector>;
  try { selector = readDataRootSelector(homeDir); }
  catch (error) {
    if (file === registryFileForRoot(fallback.dataRoot, env)) throw error;
    return false;
  }
  // Pure selection recognizes a saved root even when migration admission is pending.
  return file === registryFileForRoot(selectDataRoot({ env, homeDir, selector }).dataRoot, env);
}

function waitForStartup(pending: Promise<ServiceEndpoint>, end: number, signal?: AbortSignal): Promise<ServiceEndpoint> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal!.reason); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Vykor service startup timed out waiting for the shared startup.")); }, Math.max(1, end - Date.now()));
    signal?.addEventListener("abort", abort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Reuses a compatible service, otherwise starts a CLI; never kills an existing daemon. */
export async function ensure(options: EnsureServiceOptions = {}): Promise<ServiceEndpoint> {
  options.signal?.throwIfAborted();
  const end = Date.now() + timeout(options.timeoutMs, 10_000);
  const env = { ...process.env, ...options.env };
  const selectionEnv = options.env ?? process.env;
  if (!options.file) {
    env.VYKOR_CONFIG_DIR = (await waitForDataRootSelection({ env: selectionEnv }, { deadline: end, signal: options.signal })).dataRoot;
    env.VYKOR_DATA_DIR = selectionEnv.VYKOR_DATA_DIR;
    env.VYKOR_CHANNELS_DIR = selectionEnv.VYKOR_CHANNELS_DIR;
    env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = selectionEnv.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
    env.HOME = env.USERPROFILE = dataRootHome(selectionEnv);
  }
  const file = resolve(options.file ?? registryFileForRoot(env.VYKOR_CONFIG_DIR!, selectionEnv));
  const existing = await discover({ ...options, file, timeoutMs: Math.max(1, end - Date.now()) });
  let managed = !options.file ? { homeDir: dataRootHome(selectionEnv), dataRoot: env.VYKOR_CONFIG_DIR! } : undefined;
  if (existing && options.file && (options.command || !isManagedRegistryCandidate(file, selectionEnv))) return existing;
  if (options.file && !options.command) {
    const selected = await waitForDataRootSelection({ env: selectionEnv }, { deadline: end, signal: options.signal });
    if (file === registryFileForRoot(selected.dataRoot, selectionEnv)) {
      env.VYKOR_CONFIG_DIR = selected.dataRoot;
      env.VYKOR_DATA_DIR = selectionEnv.VYKOR_DATA_DIR;
      env.VYKOR_CHANNELS_DIR = selectionEnv.VYKOR_CHANNELS_DIR;
      env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = selectionEnv.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
      env.HOME = env.USERPROFILE = dataRootHome(selectionEnv);
      managed = { homeDir: dataRootHome(selectionEnv), dataRoot: selected.dataRoot };
    }
  }
  if (existing) { if (managed) managedEndpoints.set(existing, managed); return existing; }
  let pending = startups.get(file);
  const joinsExistingStartup = pending !== undefined;
  if (!pending) {
    const writerRoot = managed?.dataRoot;
    pending = startService({ ...options, file }, env, end, writerRoot).finally(() => { startups.delete(file); });
    startups.set(file, pending);
  }
  // The owner must wait for its timed-out child's cleanup. A joining caller has
  // its own wait budget and must not cancel that shared owner's work.
  const endpoint = joinsExistingStartup ? await waitForStartup(pending, end, options.signal) : await pending;
  options.signal?.throwIfAborted();
  if (typeof options.version === "string" && endpoint.version !== options.version
    || typeof options.version === "function" && !options.version(endpoint.version))
    throw new Error("Started service does not satisfy the requested version.");
  // Startup coordination shares one result internally; ownership belongs to each caller's handle.
  const result = { ...endpoint };
  if (managed) managedEndpoints.set(result, managed);
  return result;
}

async function startService(options: EnsureServiceOptions & { file: string }, env: Record<string, string | undefined>, end: number, writerRoot?: string): Promise<ServiceEndpoint> {
  // Order is home admission, then SDK control. Never wait for home while holding control.
  const writer = writerRoot ? await acquireDataRootWriter({ homeDir: dataRootHome(options.env ?? process.env), dataRoot: writerRoot, kind: "sdk-control", deadline: end, signal: options.signal }) : undefined;
  try {
    const lease = await acquireStartupLock(options.file, end, options.signal);
    try {
      const locked = { ...options, signal: lease.signal };
      const existing = await discover({ ...locked, timeoutMs: Math.max(1, end - Date.now()) });
      if (existing) return existing;
      return await startRegisteredService(locked, env, end, writerRoot);
    } finally { await lease.release(); }
  } finally { await writer?.release(); }
}

async function startRegisteredService(options: EnsureServiceOptions & { file: string }, env: Record<string, string | undefined>, end: number, writerRoot?: string): Promise<ServiceEndpoint> {
  const previous = await readEndpoint(options.file);
  if (previous && pidAlive(previous.pid))
    throw new Error("Registered Vykor service is incompatible or unhealthy; manage it explicitly before starting another.");
  if (!previous && await access(options.file).then(() => true, () => false))
    throw new Error("Vykor registry is malformed; inspect it before starting a service.");
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!options.command && !writerRoot)
    throw new Error("A custom registry file requires a command that writes it, or a matching VYKOR_DATA_DIR.");
  const command = options.command ?? await defaultCommand(cwd);
  options.signal?.throwIfAborted();
  if (Date.now() >= end) throw new Error("Vykor service startup timed out before process creation.");
  const started = startProcess(command, cwd, env, options.logPath);
  try {
    while (Date.now() < end) {
      options.signal?.throwIfAborted();
      // Health, protocol negotiation and authentication share the remaining startup
      // budget. A cold capability probe can take longer than the normal 1s discovery.
      const endpoint = await discover({ ...options, timeoutMs: Math.max(1, end - Date.now()) });
      if (endpoint && !sameInstance(endpoint, previous)) return endpoint;
      const failure = started.failure();
      if (failure) throw failure;
      await sleep(Math.min(50, Math.max(1, end - Date.now())), undefined, { signal: options.signal });
    }
    throw new Error("Vykor service startup timed out before compatible registration.");
  } catch (error) {
    await abandonProcess(started.child);
    const current = await readEndpoint(options.file);
    if (current && current.pid === started.child.pid && !pidAlive(current.pid)) {
      if (sameInstance(current, await readEndpoint(options.file))) await unlink(options.file).catch(() => {});
    }
    throw error;
  }
}

/** Stops only the exact registered, authenticated instance returned by discover/ensure. */
export async function stop(endpoint: ServiceEndpoint, options: Pick<DiscoverServiceOptions, "signal" | "timeoutMs"> = {}): Promise<boolean> {
  options.signal?.throwIfAborted();
  const end = Date.now() + timeout(options.timeoutMs, 5_000);
  const managed = managedEndpoints.get(endpoint);
  const writer = managed ? await acquireDataRootWriter({ ...managed, kind: "sdk-control", deadline: end, signal: options.signal }) : undefined;
  try { return await stopInstance(endpoint, options, end); }
  finally { await writer?.release(); }
}
async function stopInstance(endpoint: ServiceEndpoint, options: Pick<DiscoverServiceOptions, "signal" | "timeoutMs">, end: number): Promise<boolean> {
  const remaining = () => {
    options.signal?.throwIfAborted();
    const milliseconds = end - Date.now();
    if (milliseconds <= 0) throw new Error("Vykor service did not stop before the deadline.");
    return milliseconds;
  };
  remaining();
  if (endpoint.pid === process.pid) throw new Error("Refusing to stop the calling process.");
  if (!sameInstance(endpoint, await readEndpoint(endpoint.file))) return false;
  if (!(await probe(endpoint, { ...options, timeoutMs: Math.min(1_000, remaining()) }))) { remaining(); return false; }
  if (!sameInstance(endpoint, await readEndpoint(endpoint.file))) return false;
  remaining();
  process.kill(endpoint.pid, "SIGTERM");
  while (pidAlive(endpoint.pid) && Date.now() < end) await sleep(25, undefined, { signal: options.signal });
  if (pidAlive(endpoint.pid)) throw new Error("Vykor service did not stop before the deadline.");
  if (sameInstance(endpoint, await readEndpoint(endpoint.file))) await unlink(endpoint.file).catch(() => {});
  return true;
}
