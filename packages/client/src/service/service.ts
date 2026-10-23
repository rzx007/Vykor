import { access, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { VykorClient } from "../transport/http-client.js";
import { defaultCommand, startProcess, abandonProcess } from "./process.js";
import { pidAlive, readEndpoint, registryFile, sameInstance, type ServiceEndpoint } from "./registry.js";
import { acquireStartupLock } from "./startup-lock.js";

export interface DiscoverServiceOptions {
  /** Defaults to VYKOR_DATA_DIR/daemon/registry.json, then ~/.vykor/data/daemon/registry.json. */
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
    if (!health.ok || health.version !== endpoint.version) return false;
    // This also verifies the protocol and the credential against an authenticated route.
    const sessions = await client.sessions.list({ limit: 1, signal });
    return Array.isArray(sessions);
  } catch {
    options.signal?.throwIfAborted();
    return false;
  }
}

/** Reads and probes a local endpoint; never starts or replaces a daemon. */
export async function discover(options: DiscoverServiceOptions = {}): Promise<ServiceEndpoint | undefined> {
  options.signal?.throwIfAborted();
  timeout(options.timeoutMs, 1_000);
  const endpoint = await readEndpoint(resolve(options.file ?? registryFile()));
  if (!endpoint || !(await probe(endpoint, options))) return undefined;
  return sameInstance(endpoint, await readEndpoint(endpoint.file)) ? endpoint : undefined;
}

const startups = new Map<string, Promise<ServiceEndpoint>>();

function waitForStartup(pending: Promise<ServiceEndpoint>, signal?: AbortSignal): Promise<ServiceEndpoint> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Reuses a compatible service, otherwise starts a CLI; never kills an existing daemon. */
export async function ensure(options: EnsureServiceOptions = {}): Promise<ServiceEndpoint> {
  options.signal?.throwIfAborted();
  timeout(options.timeoutMs, 10_000);
  const env = { ...process.env, ...options.env };
  const file = resolve(options.file ?? registryFile(env));
  const existing = await discover({ ...options, file });
  if (existing) return existing;
  let pending = startups.get(file);
  if (!pending) {
    pending = startService({ ...options, file }, env).finally(() => { startups.delete(file); });
    startups.set(file, pending);
  }
  const endpoint = await waitForStartup(pending, options.signal);
  options.signal?.throwIfAborted();
  if (typeof options.version === "string" && endpoint.version !== options.version
    || typeof options.version === "function" && !options.version(endpoint.version))
    throw new Error("Started service does not satisfy the requested version.");
  return endpoint;
}

async function startService(options: EnsureServiceOptions & { file: string }, env: Record<string, string | undefined>): Promise<ServiceEndpoint> {
  const end = Date.now() + timeout(options.timeoutMs, 10_000);
  const lease = await acquireStartupLock(options.file, end, options.signal);
  try {
    const locked = { ...options, signal: lease.signal };
    const existing = await discover({ ...locked, timeoutMs: Math.max(1, Math.min(1_000, end - Date.now())) });
    if (existing) return existing;
    return await startRegisteredService(locked, env, end);
  } finally { await lease.release(); }
}

async function startRegisteredService(options: EnsureServiceOptions & { file: string }, env: Record<string, string | undefined>, end: number): Promise<ServiceEndpoint> {
  const previous = await readEndpoint(options.file);
  if (previous && pidAlive(previous.pid))
    throw new Error("Registered Vykor service is incompatible or unhealthy; manage it explicitly before starting another.");
  if (!previous && await access(options.file).then(() => true, () => false))
    throw new Error("Vykor registry is malformed; inspect it before starting a service.");
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!options.command && options.file !== registryFile(env))
    throw new Error("A custom registry file requires a command that writes it, or a matching VYKOR_DATA_DIR.");
  const command = options.command ?? await defaultCommand(cwd);
  options.signal?.throwIfAborted();
  if (Date.now() >= end) throw new Error("Vykor service startup timed out before process creation.");
  const started = startProcess(command, cwd, env);
  try {
    while (Date.now() < end) {
      options.signal?.throwIfAborted();
      const endpoint = await discover({ ...options, timeoutMs: Math.max(1, Math.min(1_000, end - Date.now())) });
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
  const milliseconds = timeout(options.timeoutMs, 5_000);
  if (endpoint.pid === process.pid) throw new Error("Refusing to stop the calling process.");
  if (!sameInstance(endpoint, await readEndpoint(endpoint.file))) return false;
  if (!(await probe(endpoint, { ...options, timeoutMs: Math.min(1_000, milliseconds) }))) return false;
  if (!sameInstance(endpoint, await readEndpoint(endpoint.file))) return false;
  process.kill(endpoint.pid, "SIGTERM");
  const end = Date.now() + milliseconds;
  while (pidAlive(endpoint.pid) && Date.now() < end) await sleep(25, undefined, { signal: options.signal });
  if (pidAlive(endpoint.pid)) throw new Error("Vykor service did not stop before the deadline.");
  if (sameInstance(endpoint, await readEndpoint(endpoint.file))) await unlink(endpoint.file).catch(() => {});
  return true;
}
