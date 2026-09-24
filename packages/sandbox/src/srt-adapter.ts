import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxConfig } from "@vykor/core";
import { normalizeSandboxConfig } from "./config.js";

export interface SrtRuntimeConfig {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
  filesystem: {
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

export interface WrappedSrtCommand {
  argv: string[];
  settingsPath: string;
  cleanup: () => Promise<void>;
}

export async function wrapCommandForSrt(
  argv: string[],
  config?: SandboxConfig,
  options: { tmpRoot?: string } = {},
): Promise<WrappedSrtCommand> {
  const resolved = normalizeSandboxConfig(config);
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "vykor-sandbox-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify(buildSrtRuntimeConfig(config), null, 2)}\n`,
    "utf-8",
  );

  return {
    argv: [
      resolved.srt.runtimeCommand,
      "--settings",
      settingsPath,
      "-c",
      shellJoin(argv),
    ],
    settingsPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function buildSrtRuntimeConfig(config?: SandboxConfig): SrtRuntimeConfig {
  const resolved = normalizeSandboxConfig(config);
  return {
    network: {
      allowedDomains: resolved.network.allowedDomains,
      deniedDomains: resolved.network.deniedDomains,
    },
    filesystem: {
      allowRead: resolved.filesystem.allowRead,
      denyRead: resolved.filesystem.denyRead,
      allowWrite: resolved.filesystem.allowWrite,
      denyWrite: resolved.filesystem.denyWrite,
    },
  };
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
