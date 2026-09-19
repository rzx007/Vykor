import {
  daemonPidAlive,
  terminateDaemonProcess,
} from "@openharness/server/daemon-host";
import type { DaemonRegistry } from "@openharness/server";

export { daemonPidAlive, terminateDaemonProcess };

export type DaemonProbeStatus = "ready" | "stale" | "unreachable";
export type DaemonProbeFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export interface DaemonProbeOptions {
  fetch?: DaemonProbeFetch;
  pidAlive?: (pid: number) => boolean;
  timeoutMs?: number;
  expectedVersion?: string;
  minimumStartedAt?: number;
}

export async function probeDaemonRegistry(
  registry: DaemonRegistry,
  options: DaemonProbeOptions = {},
): Promise<DaemonProbeStatus> {
  const pidAlive = options.pidAlive ?? daemonPidAlive;
  if (!pidAlive(registry.pid)) return "unreachable";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_000);
  try {
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(`${registry.url.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return "unreachable";
    const health = await response.json() as { ok?: unknown; version?: unknown };
    if (health.ok !== true) return "unreachable";

    if (options.expectedVersion && (
      registry.version !== options.expectedVersion || health.version !== options.expectedVersion
    )) return "stale";
    if (options.minimumStartedAt && registry.startedAt < options.minimumStartedAt) return "stale";
    return "ready";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}
