import type { CredentialStorage } from "@vykor/auth";

export async function prepareSecretProviderHeaders(
  storage: CredentialStorage,
  provider: string,
  currentNames: string[] = [],
  updates: Record<string, string | null> | undefined,
) {
  if (updates !== undefined && (!updates || typeof updates !== "object" || Array.isArray(updates))) throw new Error("机密请求头必须按名称填写。");
  const names = new Map(currentNames.map((name) => [name.toLowerCase(), name]));
  const changes: Record<string, string | null> = {};
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(updates ?? {})) {
    if (!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) || (value !== null && (typeof value !== "string" || /[\r\n\0]/.test(value) || value.length > 32768))) throw new Error("机密请求头名称或值无效。");
    const key = `header:${name.toLowerCase()}`;
    if (seen.has(key)) throw new Error("机密请求头名称不能重复（不区分大小写）。");
    seen.add(key);
    changes[key] = value;
    if (value === null) names.delete(name.toLowerCase()); else names.set(name.toLowerCase(), name);
  }
  for (const name of names.values()) {
    const key = `header:${name.toLowerCase()}`;
    const value = Object.hasOwn(changes, key) ? changes[key] : await storage.loadCredential(provider, key);
    if (value === undefined || value === null) throw new Error(`机密请求头 ${name} 的凭据不可用，请重新填写。`);
    headers[name] = value;
  }
  return { names: [...names.values()], changes, headers };
}
