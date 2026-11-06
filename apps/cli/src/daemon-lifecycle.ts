import { networkInterfaces } from "node:os";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/application-client";
import { Service } from "@vykor/application-client/service";
import {
  daemonPidAlive,
  terminateDaemonProcess,
} from "@vykor/server/daemon-host";
import type { DaemonRegistry } from "@vykor/server";

export { daemonPidAlive, terminateDaemonProcess };

export function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export async function verifyDaemonProcess(registry: DaemonRegistry): Promise<boolean> {
  try {
    if (!registry.token?.trim()) return false;
    const url = new URL(registry.url);
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (url.hostname === "[::]") url.hostname = "[::1]";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!isLoopbackHost(host) && !Object.values(networkInterfaces()).flat()
      .some(address => address?.address === host)) return false;

    const response = await fetch(new URL("/debug/process", url), {
      headers: {
        authorization: `Bearer ${registry.token}`,
        "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION),
      },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const identity = await response.json() as { pid?: number };
    return identity.pid === registry.pid;
  } catch {
    return false;
  }
}

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
  if (registry.launcher) {
    const endpoint = await Service.discover({ timeoutMs: options.timeoutMs ?? 1_000 });
    return endpoint && endpoint.pid === registry.pid && endpoint.url === registry.url &&
      endpoint.token === registry.token && endpoint.startedAt === registry.startedAt
      ? "ready" : "unreachable";
  }


  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_000);
  try {
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(`${registry.url.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return "unreachable";
    const health = await response.json() as { ok?: unknown; version?: unknown; ready?: unknown; restartPrepared?: unknown };
    if (health.ok !== true || health.ready === false || health.restartPrepared === true) return "unreachable";

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
