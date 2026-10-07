import { CredentialStorage } from "@vykor/auth";
import { getConfigDir, SettingsConflictError, withSettingsFileLock } from "@vykor/core";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadRuntimeSecrets(scope: string, names: string[]): Promise<Record<string, string>> {
  const path = join(getConfigDir(), "runtime-environment-secrets.json");
  try { const raw = JSON.parse(await readFile(path, "utf8")); if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("机密环境变量文件格式无效。"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const storage = new CredentialStorage(path);
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = await storage.loadCredential(scope, name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function saveRuntimeSecrets(scope: string, values: Record<string, string | null>, expected?: Record<string, string | null>): Promise<void> {
  const path = join(getConfigDir(), "runtime-environment-secrets.json");
  await mkdir(getConfigDir(), { recursive: true });
  await withSettingsFileLock(async () => {
    try { await writeFile(path, "{}", { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await chmod(path, 0o600);
    const storage = new CredentialStorage(path);
    await loadRuntimeSecrets(scope, Object.keys(values));
    if (expected) for (const [name, value] of Object.entries(expected)) {
      if ((await storage.loadCredential(scope, name) ?? null) !== value) throw new SettingsConflictError("runtimeSecret");
    }
    // Replace this scope as a group, preserving unchanged keys the caller supplies.
    for (const [name, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (value !== null && (typeof value !== "string" || value.includes("\0")))) throw new Error("机密环境变量无效。");
    }
    await storage.updateCredentials(scope, values);
  }, { lockPath: `${path}.lock` });
}
