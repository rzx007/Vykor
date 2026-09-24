import { PROVIDERS, findByName } from "@vykor/api";
import { CredentialStorage, describeCodexAuthState } from "@vykor/auth";

import type { AuthService } from "../settings-api.js";
import { validateProviderCredential } from "./credential-validation.js";

export function createDefaultAuthService(): AuthService {
  const storage = new CredentialStorage();
  return {
    async status() {
      const providers = await storage.listStoredProviders();
      const codexState = await describeCodexAuthState();
      const envProviders: Array<{ name: string; envKey: string }> = [];
      for (const spec of PROVIDERS) {
        if (spec.envKey && process.env[spec.envKey]) {
          envProviders.push({ name: spec.name, envKey: spec.envKey });
        }
      }
      return {
        codex: {
          configured: codexState.configured,
          state: codexState.state,
          source: codexState.source,
          ...(codexState.detail ? { detail: codexState.detail } : {}),
          ...(codexState.profileLabel ? { profileLabel: codexState.profileLabel } : {}),
        },
        storedProviders: providers,
        envProviders,
      };
    },
    async login({ provider, apiKey }) {
      const providerName = normalizeAuthProvider(provider);
      if (!providerName) throw new Error("Usage: /auth login <provider> <api-key> or /auth login codex");
      if (providerName === "codex") {
        const state = await describeCodexAuthState();
        if (!state.configured) {
          throw new Error(`Codex Subscription ${state.state}: ${state.detail ?? state.source}`);
        }
        return {
          message: `Codex Subscription ready${state.profileLabel ? ` (${state.profileLabel})` : ""}. Use /provider codex to switch.`,
        };
      }
      if (!apiKey) throw new Error("Usage: /auth login <provider> <api-key>");
      const spec = findByName(providerName);
      if (!spec) throw new Error(`Unknown provider: ${providerName}. Use /provider to see available providers.`);
      if (spec.backendType === "anthropic" || spec.backendType === "openai_compat") {
        await validateProviderCredential({
          providerName,
          providerDisplayName: spec.displayName,
          backendType: spec.backendType,
          apiKey,
          baseUrl: spec.defaultBaseURL,
        });
      }
      await storage.storeApiKey(providerName, apiKey);
      return { message: `API key stored for ${spec.displayName} (${spec.name}).` };
    },
    async logout({ provider }) {
      const providerName = normalizeAuthProvider(provider) ?? provider.trim();
      if (!providerName) throw new Error("Usage: /auth logout <provider>");
      await storage.clearProviderCredentials(providerName);
      const suffix = providerName === "codex" ? " Codex CLI auth.json was not removed." : "";
      return { message: `Credentials cleared for ${providerName}.${suffix}` };
    },
  };
}

function normalizeAuthProvider(target?: string): string | undefined {
  const normalized = target?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (
    normalized === "codex" ||
    normalized === "openai-codex" ||
    normalized === "codex-subscription"
  ) {
    return "codex";
  }
  return normalized;
}
