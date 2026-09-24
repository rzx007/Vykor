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
import {
  getMcpOAuthFilePath,
  type McpOAuthCredentialRecord,
  type McpOAuthStoreFile,
} from "@vykor/core";

export class McpOAuthStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpOAuthStoreError";
  }
}

export type ExclusiveCredentialOperation<T> = (
  current: McpOAuthCredentialRecord | undefined,
) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: T }>;

const EMPTY_STORE: McpOAuthStoreFile = { version: 1, servers: {} };

export class McpOAuthCredentialStore {
  constructor(
    private readonly filePath = getMcpOAuthFilePath(),
    private readonly clock = () => Date.now(),
  ) {}

  async get(name: string): Promise<McpOAuthCredentialRecord | undefined> {
    return (await this.read()).servers[name];
  }

  async list(): Promise<Record<string, McpOAuthCredentialRecord>> {
    return { ...(await this.read()).servers };
  }

  async set(name: string, value: McpOAuthCredentialRecord): Promise<void> {
    await this.update(name, () => value);
  }

  async delete(name: string): Promise<boolean> {
    return this.runExclusive(name, async current => ({
      next: undefined,
      result: current !== undefined,
    }));
  }

  async update(
    name: string,
    mutate: (current: McpOAuthCredentialRecord | undefined) => McpOAuthCredentialRecord | undefined,
  ): Promise<McpOAuthCredentialRecord | undefined> {
    return this.runExclusive(name, async current => {
      const next = mutate(current);
      return { next, result: next };
    });
  }

  async runExclusive<T>(name: string, operation: ExclusiveCredentialOperation<T>): Promise<T> {
    return this.withLock(async () => {
      const file = await this.read();
      const current = file.servers[name];
      const { next, result } = await operation(current);
      if (next === undefined) {
        delete file.servers[name];
      } else {
        file.servers[name] = {
          ...next,
          revision: Math.max(next.revision, current?.revision ?? 0) + 1,
        };
      }
      await this.write(file);
      return result;
    });
  }

  private async read(): Promise<McpOAuthStoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, servers: {} };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as McpOAuthStoreFile;
      if (
        parsed?.version !== 1 ||
        !parsed.servers ||
        typeof parsed.servers !== "object" ||
        Array.isArray(parsed.servers) ||
        !Object.values(parsed.servers).every(isCredentialRecord)
      ) {
        throw new Error("unsupported shape");
      }
      return parsed;
    } catch {
      throw new McpOAuthStoreError(
        "invalid-mcp-oauth-store",
        `OAuth credential file is invalid: ${this.filePath}`,
      );
    }
  }

  private async write(value: McpOAuthStoreFile): Promise<void> {
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
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: this.clock() }), "utf8");
        try {
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
          throw new McpOAuthStoreError("credential-lock-timeout", "Timed out waiting for OAuth credential lock");
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
}

function isCredentialRecord(value: unknown): value is McpOAuthCredentialRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<McpOAuthCredentialRecord>;
  return typeof record.serverUrl === "string" &&
    typeof record.revision === "number" &&
    !!record.binding &&
    typeof record.binding.issuer === "string" &&
    typeof record.binding.redirectUri === "string" &&
    typeof record.binding.authorizationEndpoint === "string" &&
    typeof record.binding.tokenEndpoint === "string" &&
    !!record.registration &&
    typeof record.registration.client_id === "string" &&
    !!record.tokens &&
    typeof record.tokens.accessToken === "string" &&
    typeof record.tokens.tokenType === "string" &&
    Array.isArray(record.tokens.scope) &&
    record.tokens.scope.every(scope => typeof scope === "string");
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

export function shouldReuseCredentialAfterLock(
  before: McpOAuthCredentialRecord,
  current: McpOAuthCredentialRecord | undefined,
  now: number,
): boolean {
  if (!current) throw new McpOAuthStoreError("oauth-credential-removed", "OAuth credential was removed");
  if (
    current.serverUrl !== before.serverUrl ||
    current.binding.issuer !== before.binding.issuer ||
    current.binding.redirectUri !== before.binding.redirectUri
  ) {
    throw new McpOAuthStoreError("oauth-binding-changed", "OAuth credential binding changed");
  }
  if (current.tokens.refreshToken !== before.tokens.refreshToken) return true;
  return current.tokens.accessToken !== before.tokens.accessToken &&
    (current.tokens.expiresAt ?? Number.POSITIVE_INFINITY) - now > 30_000;
}
