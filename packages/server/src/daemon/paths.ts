import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir } from "@vykor/host-config";

export type DaemonExecutionSurface = "desktop_managed" | "cli_advanced";

export interface DaemonRegistry {
  url: string;
  pid: number;
  token: string;
  storePath: string;
  startedAt: number;
  version: string;
  executionSurface?: DaemonExecutionSurface;
  launcher?: "desktop" | "cli";
  supervised?: boolean;
}

export function createDaemonRegistryEntry(input: {
  url: string;
  pid: number;
  token: string;
  storePath: string;
  version: string;
  executionSurface: DaemonExecutionSurface;
  startedAt?: number;
  launcher?: DaemonRegistry["launcher"];
  supervised?: boolean;
}): DaemonRegistry {
  return {
    url: input.url,
    pid: input.pid,
    token: input.token,
    storePath: input.storePath,
    startedAt: input.startedAt ?? Date.now(),
    version: input.version,
    executionSurface: input.executionSurface,
    ...(input.launcher !== undefined ? { launcher: input.launcher } : {}),
    ...(input.supervised !== undefined ? { supervised: input.supervised } : {}),
  };
}

export function getDefaultSessionStorePath(): string {
  return join(getDataDir(), "session-runtime", "sessions.db");
}

export function getDaemonRegistryPath(): string {
  return join(getDataDir(), "daemon", "registry.json");
}

export function createBearerToken(): string {
  return randomBytes(24).toString("base64url");
}

export function writeDaemonRegistry(registry: DaemonRegistry, path = getDaemonRegistryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve publication error */ }
    throw error;
  }
}

export function readDaemonRegistry(path = getDaemonRegistryPath()): DaemonRegistry | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DaemonRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function sameDaemonRegistration(
  current: DaemonRegistry | undefined,
  expected: DaemonRegistry,
): boolean {
  return !!current && current.pid === expected.pid && current.url === expected.url &&
    current.token === expected.token && current.startedAt === expected.startedAt &&
    current.version === expected.version && current.storePath === expected.storePath;
}

export function clearMatchingDaemonRegistry(registry: DaemonRegistry, path: string): void {
  if (sameDaemonRegistration(readDaemonRegistry(path), registry)) clearDaemonRegistry(path);
}

export function clearDaemonRegistry(path = getDaemonRegistryPath()): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing or already removed.
  }
}
