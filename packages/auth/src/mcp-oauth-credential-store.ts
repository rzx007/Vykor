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
  type CredentialMutationContext,
  type McpOAuthCredentialRecord,
  type McpOAuthStoreFileV2,
} from "@vykor/core";

export class McpOAuthStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpOAuthStoreError";
  }
}

export type ExclusiveCredentialOperation<T> = (
  current: McpOAuthCredentialRecord | undefined,
  context: CredentialMutationContext,
) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: T }>;

/** In-memory shape shared by v1 and v2 files; v1 simply has no epochs. */
interface NormalizedStore {
  servers: Record<string, McpOAuthCredentialRecord>;
  logoutEpochs: Record<string, number>;
}

/**
 * File-backed credential store.
 *
 * The on-disk format is version 2 once any write happens: the same plaintext
 * records plus a per-server `logoutEpochs` counter. Version 1 files stay
 * readable but are never rewritten by a read. An operation that returns its
 * input record unchanged is a no-op: no write and no revision bump.
 */
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

  /** Remove `name` and return the record that was deleted (if any). */
  async takeAndDelete(name: string): Promise<McpOAuthCredentialRecord | undefined> {
    return this.withLock(async () => {
      const file = await this.read();
      const previous = file.servers[name];
      delete file.servers[name];
      // Even an empty delete advances the epoch so a late login callback from a
      // process that started before this logout can never be committed.
      file.logoutEpochs[name] = incrementLogoutEpoch(file.logoutEpochs[name] ?? 0);
      await storageIo(() => this.write(file));
      return previous;
    });
  }

  /** Plain removal; delegates to {@link takeAndDelete} so the epoch still advances. */
  async delete(name: string): Promise<boolean> {
    return (await this.takeAndDelete(name)) !== undefined;
  }

  /** Read the current logout counter for one service under the file lock. */
  async readLogoutEpoch(name: string): Promise<number> {
    return this.withLock(async () => (await this.read()).logoutEpochs[name] ?? 0);
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
      const context: CredentialMutationContext = {
        nextRevision: (current?.revision ?? 0) + 1,
        logoutEpoch: file.logoutEpochs[name] ?? 0,
      };
      const { next, result } = await operation(current, context);
      if (next === current) return result;
      if (next === undefined) {
        delete file.servers[name];
      } else {
        file.servers[name] = { ...next, revision: context.nextRevision };
      }
      await storageIo(() => this.write(file));
      return result;
    });
  }

  private async read(): Promise<NormalizedStore> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { servers: {}, logoutEpochs: {} };
      }
      throw new McpOAuthStoreError("credential-storage-failed", "OAuth credential file could not be read");
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoreRecord(parsed)) throw new Error("unsupported shape");
      if (parsed.version === 1) {
        if (!isServersRecord(parsed.servers)) throw new Error("unsupported shape");
        return { servers: parsed.servers, logoutEpochs: {} };
      }
      if (parsed.version === 2) {
        if (!isEpochsRecord(parsed.logoutEpochs) || !isServersRecord(parsed.servers)) {
          throw new Error("unsupported shape");
        }
        return { servers: parsed.servers, logoutEpochs: parsed.logoutEpochs };
      }
      throw new Error("unsupported version");
    } catch {
      throw new McpOAuthStoreError(
        "invalid-mcp-oauth-store",
        `OAuth credential file is invalid: ${this.filePath}`,
      );
    }
  }

  private async write(value: NormalizedStore): Promise<void> {
    const file: McpOAuthStoreFileV2 = {
      version: 2,
      logoutEpochs: value.logoutEpochs,
      servers: value.servers,
    };
    await storageIo(() => mkdir(dirname(this.filePath), { recursive: true }));
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(file, null, 2), "utf8");
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
    await storageIo(() => mkdir(dirname(this.filePath), { recursive: true }));
    const startedAt = this.clock();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
          throw new McpOAuthStoreError("credential-storage-failed", "OAuth credential lock could not be opened");
        });
        try {
          await storageIo(() => handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: this.clock() }), "utf8"));
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

async function storageIo<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new McpOAuthStoreError("credential-storage-failed", "OAuth credential storage operation failed"); }
}

function isStoreRecord(value: unknown): value is { version: number; servers: unknown; logoutEpochs?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { version?: unknown; servers?: unknown };
  return typeof record.version === "number" && record.servers !== undefined;
}

function isServersRecord(value: unknown): value is Record<string, McpOAuthCredentialRecord> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(isCredentialRecord);
}

function isEpochsRecord(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(epoch =>
      typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0,
    );
}

/** Advance a logout counter by one, refusing to wrap past MAX_SAFE_INTEGER. */
function incrementLogoutEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new McpOAuthStoreError("invalid-mcp-oauth-epoch", "OAuth logout epoch is invalid");
  }
  if (epoch === Number.MAX_SAFE_INTEGER) {
    throw new McpOAuthStoreError("invalid-mcp-oauth-epoch", "OAuth logout epoch overflowed");
  }
  return epoch + 1;
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
