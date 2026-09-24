import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir } from "@vykor/core";

export type DaemonExecutionSurface = "desktop_managed" | "cli_advanced";

export interface DaemonRegistry {
  url: string;
  pid: number;
  token: string;
  storePath: string;
  startedAt: number;
  version: string;
  executionSurface?: DaemonExecutionSurface;
}

export function createDaemonRegistryEntry(input: {
  url: string;
  pid: number;
  token: string;
  storePath: string;
  version: string;
  executionSurface: DaemonExecutionSurface;
  startedAt?: number;
}): DaemonRegistry {
  return {
    url: input.url,
    pid: input.pid,
    token: input.token,
    storePath: input.storePath,
    startedAt: input.startedAt ?? Date.now(),
    version: input.version,
    executionSurface: input.executionSurface,
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
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

export function readDaemonRegistry(path = getDaemonRegistryPath()): DaemonRegistry | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as DaemonRegistry;
}

export function clearDaemonRegistry(path = getDaemonRegistryPath()): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing or already removed.
  }
}
