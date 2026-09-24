import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { getChannelCredentialsFilePath } from "@vykor/core";

export type FeishuDomain = "feishu" | "lark";

export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  allowFrom: Record<string, string>;
  replyAtBotNames?: string[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export interface ChannelConfigFile {
  version: 2;
  channels: { feishu?: FeishuChannelConfig };
}

export class ChannelConfigStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChannelConfigStoreError";
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(filePath: string, detail: string): ChannelConfigStoreError {
  return new ChannelConfigStoreError(
    "invalid-channel-config-store",
    `Channel config file is invalid (${detail}): ${filePath}`,
  );
}

function normalizeDomain(value: unknown, filePath: string): FeishuDomain {
  if (value === undefined || value === "feishu") return "feishu";
  if (value === "lark") return "lark";
  throw invalid(filePath, "domain");
}

function normalizeAllowFrom(value: unknown, filePath: string): Record<string, string> {
  if (!isRecord(value)) throw invalid(filePath, "allowFrom");
  const allowFrom: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || key.length === 0 || typeof raw !== "string" || raw.length === 0) {
      throw invalid(filePath, "allowFrom entry");
    }
    allowFrom[key] = raw;
  }
  return allowFrom;
}

function normalizeFeishu(value: unknown, filePath: string): FeishuChannelConfig {
  if (!isRecord(value)) throw invalid(filePath, "feishu");
  if (typeof value.enabled !== "boolean") throw invalid(filePath, "enabled");
  if (typeof value.appId !== "string" || value.appId.length === 0) throw invalid(filePath, "appId");
  if (typeof value.appSecret !== "string" || value.appSecret.length === 0) throw invalid(filePath, "appSecret");
  const replyAtBotNames = value.replyAtBotNames;
  if (
    replyAtBotNames !== undefined &&
    (!Array.isArray(replyAtBotNames) || !replyAtBotNames.every((n) => typeof n === "string"))
  ) {
    throw invalid(filePath, "replyAtBotNames");
  }
  for (const flag of ["sendProgress", "sendToolHints"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw invalid(filePath, flag);
  }
  return {
    enabled: value.enabled,
    appId: value.appId,
    appSecret: value.appSecret,
    domain: normalizeDomain(value.domain, filePath),
    allowFrom: normalizeAllowFrom(value.allowFrom, filePath),
    ...(replyAtBotNames !== undefined ? { replyAtBotNames: replyAtBotNames as string[] } : {}),
    ...(value.sendProgress !== undefined ? { sendProgress: value.sendProgress as boolean } : {}),
    ...(value.sendToolHints !== undefined ? { sendToolHints: value.sendToolHints as boolean } : {}),
  };
}

export class ChannelConfigStore {
  constructor(
    private readonly filePath = getChannelCredentialsFilePath(),
    private readonly clock = () => Date.now(),
  ) {}

  async getFeishu(): Promise<FeishuChannelConfig | undefined> {
    return this.withLock(async () => (await this.read()).channels.feishu);
  }

  async setFeishu(config: FeishuChannelConfig): Promise<void> {
    await this.withLock(async () => {
      const file = await this.read();
      file.channels.feishu = normalizeFeishu(config, this.filePath);
      await this.write(file);
    });
  }

  async updateFeishu(
    mutate: (current: FeishuChannelConfig | undefined) => FeishuChannelConfig | undefined,
  ): Promise<FeishuChannelConfig | undefined> {
    return this.withLock(async () => {
      const file = await this.read();
      const next = mutate(file.channels.feishu);
      if (next === undefined) {
        delete file.channels.feishu;
      } else {
        file.channels.feishu = normalizeFeishu(next, this.filePath);
      }
      await this.write(file);
      return file.channels.feishu;
    });
  }

  async deleteFeishu(): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.read();
      if (!file.channels.feishu) return false;
      delete file.channels.feishu;
      await this.write(file);
      return true;
    });
  }

  private async read(): Promise<ChannelConfigFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, channels: {} };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid(this.filePath, "json");
    }
    if (!isRecord(parsed)) throw invalid(this.filePath, "root");
    // 旧 v1 凭据文件（只有 appSecret）视为未配置渠道。
    if (parsed.version === 1) return { version: 2, channels: {} };
    if (parsed.version !== 2 || !isRecord(parsed.channels)) throw invalid(this.filePath, "version");
    const channels: ChannelConfigFile["channels"] = {};
    if (parsed.channels.feishu !== undefined) {
      channels.feishu = normalizeFeishu(parsed.channels.feishu, this.filePath);
    }
    return { version: 2, channels };
  }

  private async write(value: ChannelConfigFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const startedAt = this.clock();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: this.clock() }),
            "utf8",
          );
          return await operation();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await isStaleLock(lockPath, this.clock())) {
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
        if (this.clock() - startedAt >= 10_000) {
          throw new ChannelConfigStoreError(
            "channel-config-lock-timeout",
            "Timed out waiting for channel config lock",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

async function isStaleLock(path: string, now: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (now - info.mtimeMs <= 30_000) return false;
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
    if (!Number.isInteger(parsed.pid)) return false;
    try {
      process.kill(parsed.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}
