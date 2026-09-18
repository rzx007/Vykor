import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { getChannelCredentialsFilePath } from "@openharness/core";

export class ChannelCredentialStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChannelCredentialStoreError";
  }
}

interface ChannelCredentialStoreFile {
  version: 1;
  credentials: Record<string, { appSecret: string }>;
}

export class ChannelCredentialStore {
  constructor(
    private readonly filePath = getChannelCredentialsFilePath(),
    private readonly clock = () => Date.now(),
  ) {}

  async get(appId: string): Promise<string | undefined> {
    assertSafeAppId(appId);
    return this.withLock(async () => {
      const file = await this.read();
      if (!Object.prototype.hasOwnProperty.call(file.credentials, appId)) return undefined;
      return file.credentials[appId]?.appSecret;
    });
  }

  async set(appId: string, secret: string): Promise<void> {
    assertSafeAppId(appId);
    await this.withLock(async () => {
      if (!secret) {
        throw new ChannelCredentialStoreError(
          "invalid-channel-credential",
          "Channel app secret must be a non-empty string",
        );
      }
      const file = await this.read();
      file.credentials[appId] = { appSecret: secret };
      await this.write(file);
    });
  }

  async delete(appId: string): Promise<boolean> {
    assertSafeAppId(appId);
    return this.withLock(async () => {
      const file = await this.read();
      if (!Object.prototype.hasOwnProperty.call(file.credentials, appId)) return false;
      delete file.credentials[appId];
      await this.write(file);
      return true;
    });
  }

  private async read(): Promise<ChannelCredentialStoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, credentials: {} };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as ChannelCredentialStoreFile;
      if (
        parsed?.version !== 1 ||
        !parsed.credentials ||
        typeof parsed.credentials !== "object" ||
        Array.isArray(parsed.credentials) ||
        !Object.values(parsed.credentials).every(isCredentialRecord)
      ) {
        throw new Error("unsupported shape");
      }
      return parsed;
    } catch {
      throw new ChannelCredentialStoreError(
        "invalid-channel-credential-store",
        `Channel credential file is invalid: ${this.filePath}`,
      );
    }
  }

  private async write(value: ChannelCredentialStoreFile): Promise<void> {
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
        // Once the lock file is opened, the write and the operation share one
        // try/finally so a write failure can never strand the lock or its fd.
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
          throw new ChannelCredentialStoreError(
            "channel-credential-lock-timeout",
            "Timed out waiting for channel credential lock",
          );
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
}

function isCredentialRecord(value: unknown): value is { appSecret: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof (value as { appSecret?: unknown }).appSecret === "string";
}

function assertSafeAppId(appId: unknown): asserts appId is string {
  if (
    typeof appId !== "string" ||
    appId.length === 0 ||
    appId === "__proto__" ||
    appId === "constructor" ||
    appId === "prototype"
  ) {
    throw new ChannelCredentialStoreError(
      "invalid-channel-credential-app-id",
      `Invalid channel credential app id: ${String(appId)}`,
    );
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
