import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeDaemonBaseUrl } from "../transport/http-transport.js";

/** Identifies one registered local daemon instance, including its credential. */
export interface ServiceEndpoint {
  readonly file: string;
  readonly url: string;
  readonly pid: number;
  readonly token: string;
  readonly version: string;
  readonly startedAt: number;
  readonly storePath?: string;
}

export function registryFile(env: Record<string, string | undefined> = process.env): string {
  const config = env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  return resolve(env.VYKOR_DATA_DIR ?? join(config, "data"), "daemon", "registry.json");
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { return process.kill(pid, 0); }
  catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

export async function readEndpoint(file: string): Promise<ServiceEndpoint | undefined> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.token !== "string" || !value.token.trim()
      || typeof value.version !== "string" || !value.version.trim()
      || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) return undefined;
    const url = normalizeDaemonBaseUrl(value.url);
    const address = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) return undefined;
    return {
      file: resolve(file), url, pid: value.pid, token: value.token,
      version: value.version, startedAt: value.startedAt,
      ...(typeof value.storePath === "string" ? { storePath: value.storePath } : {}),
    };
  } catch { return undefined; }
}

export function sameInstance(left: ServiceEndpoint, right: ServiceEndpoint | undefined): boolean {
  return right !== undefined && left.file === right.file && left.url === right.url
    && left.pid === right.pid && left.token === right.token
    && left.startedAt === right.startedAt && left.version === right.version;
}
