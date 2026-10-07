import { readFile, writeFile, mkdir, access, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface CredentialData {
  [provider: string]: {
    [key: string]: string;
  };
}

export class CredentialStorage {
  private filePath: string;
  private cache: CredentialData | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(getDefaultConfigDir(), "credentials.json");
  }

  async storeCredential(provider: string, key: string, value: string): Promise<void> {
    await this.updateCredentials(provider, { [key]: value });
  }

  async loadCredential(provider: string, key: string): Promise<string | undefined> {
    const data = await this.load();
    return Object.hasOwn(data, provider) && Object.hasOwn(data[provider]!, key) ? data[provider]![key] : undefined;
  }

  async clearProviderCredentials(provider: string): Promise<void> {
    const data = await this.load(true);
    if (Object.hasOwn(data, provider)) {
      delete data[provider];
      await this.save(data);
    }
  }

  async updateCredentials(provider: string, values: Record<string, string | null>): Promise<void> {
    const data = await this.load(true);
    const entries: Record<string, string> = Object.assign(Object.create(null), Object.hasOwn(data, provider) ? data[provider] : {});
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete entries[key]; else entries[key] = value;
    }
    if (Object.keys(entries).length) Object.defineProperty(data, provider, { value: entries, configurable: true, writable: true, enumerable: true }); else delete data[provider];
    await this.save(data);
  }

  async listStoredProviders(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data);
  }

  async loadApiKey(provider: string): Promise<string | undefined> {
    return this.loadCredential(provider, "api_key");
  }

  async storeApiKey(provider: string, apiKey: string): Promise<void> {
    await this.storeCredential(provider, "api_key", apiKey);
  }

  getFilePath(): string {
    return this.filePath;
  }

  private async load(refresh = false): Promise<CredentialData> {
    if (this.cache && !refresh) return this.cache;
    try {
      await access(this.filePath);
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(entries => !entries || typeof entries !== "object" || Array.isArray(entries) || Object.values(entries).some(value => typeof value !== "string"))) throw new Error("Credential file has an invalid format");
      this.cache = parsed as CredentialData;
      return this.cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = {};
      return this.cache;
    }
  }

  private async save(data: CredentialData): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
      this.cache = data;
    } catch (error) {
      this.cache = null;
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function getDefaultConfigDir(): string {
  return process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
}
