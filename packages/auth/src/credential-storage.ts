import { readFile, writeFile, mkdir, access } from "node:fs/promises";
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
    const data = await this.load();
    if (!data[provider]) data[provider] = {};
    data[provider]![key] = value;
    await this.save(data);
  }

  async loadCredential(provider: string, key: string): Promise<string | undefined> {
    const data = await this.load();
    return data[provider]?.[key];
  }

  async clearProviderCredentials(provider: string): Promise<void> {
    const data = await this.load();
    if (data[provider]) {
      delete data[provider];
      await this.save(data);
    }
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

  private async load(): Promise<CredentialData> {
    if (this.cache) return this.cache;
    try {
      await access(this.filePath);
      const raw = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(raw) as CredentialData;
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  private async save(data: CredentialData): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    this.cache = data;
  }
}

function getDefaultConfigDir(): string {
  return process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
}
