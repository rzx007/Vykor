import { detectProvider, findByName } from "@vykor/api";
import type { Settings } from "@vykor/core";

import { CredentialStorage } from "./credential-storage.js";
import { loadCodexCredential } from "./external.js";

export interface ApiKeyResolutionOptions {
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  model?: string;
}

export async function resolveApiKey(
  settings: Settings,
  options: ApiKeyResolutionOptions = {},
  storage: CredentialStorage = new CredentialStorage(),
): Promise<string> {
  // Call-site overrides win. settings.apiKey is not treated as explicit here:
  // loadSettings may inject ANTHROPIC/OPENAI env keys into it, and those must not
  // be forwarded to a differently named (especially custom) provider endpoint.
  if (options.apiKey) return options.apiKey;

  const model = options.model ?? settings.model;
  const providerName = options.provider ?? settings.provider;
  if (providerName) {
    if (providerName === "codex") {
      try {
        return (await loadCodexCredential()).value;
      } catch {
        return "";
      }
    }
    const stored = await storage.loadApiKey(providerName);
    if (stored) return stored;
    const provider = findByName(providerName);
    if (provider?.envKey && process.env[provider.envKey]) return process.env[provider.envKey]!;
    // Custom / unknown named providers must not borrow another provider's key via
    // model detection or the global settings.apiKey / env fallbacks.
    if (!provider) return "";
    if (settings.apiKey) return settings.apiKey;
    return "";
  }

  if (settings.apiKey) return settings.apiKey;

  const detected = detectProvider(model, undefined, options.baseUrl ?? settings.baseUrl);
  if (detected) {
    const stored = await storage.loadApiKey(detected.name);
    if (stored) return stored;
    if (detected.envKey && process.env[detected.envKey]) return process.env[detected.envKey]!;
  }

  return process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
}
