import { createHash } from "node:crypto";
import { loadSettings } from "@vykor/core";
import { CredentialStorage, resolveApiKey } from "@vykor/auth";
import { findByName } from "@vykor/api";
import { validateProviderCredential } from "./application/default-services/credential-validation.js";

async function connection(provider: string) {
  const settings = await loadSettings();
  const storage = new CredentialStorage();
  const custom = settings.customProviders?.find((item) => item.id === provider);
  const spec = findByName(provider);
  if (!custom && !spec) throw new Error("供应商不存在，请重新检测。");
  const apiKey = await resolveApiKey(settings, { provider }, storage);
  const headers = { ...custom?.headers };
  for (const name of custom?.secretHeaderNames ?? []) {
    const value = await storage.loadCredential(provider, `header:${name.toLowerCase()}`);
    if (value === undefined) throw new Error(`机密请求头 ${name} 不可用，请重新配置。`);
    headers[name] = value;
  }
  return { apiKey, providerName: provider, providerDisplayName: custom?.displayName ?? spec!.displayName,
    baseUrl: custom?.baseUrl ?? (settings.provider === provider ? settings.baseUrl : undefined) ?? spec?.defaultBaseURL,
    backendType: custom ? "openai_compat" as const : spec!.backendType, headers };
}

export async function storedProviderConnectionFingerprint(provider: string): Promise<string> {
  return createHash("sha256").update(JSON.stringify(await connection(provider))).digest("hex");
}

export async function testStoredProviderConnection(input: { provider: string; model: string }): Promise<{ fingerprint: string; checkedAt: number }> {
  const value = await connection(input.provider);
  if (value.backendType !== "openai_compat" && value.backendType !== "anthropic") throw new Error("当前订阅适配器没有独立模型列表验证接口，验证状态保持未知。");
  await validateProviderCredential({ ...value, backendType: value.backendType, model: input.model });
  return { fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex"), checkedAt: Date.now() };
}
