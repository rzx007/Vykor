import type { Settings } from "@vykor/core";
import { CredentialStorage, describeCodexAuthState } from "@vykor/auth";
import { findByName, detectProvider } from "@vykor/api";
import { resolveApiKey } from "@vykor/auth";

export interface ApiKeyCheck {
  ok: boolean;
  /** Human-readable provenance, e.g. "credentials.json [deepseek]" or "not set". */
  source: string;
}

/**
 * 真实地判断 API key 是否已配置，并给出来源。
 *
 * 旧的 doctor 只看 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 两个环境变量，
 * 完全忽略 credentials.json、settings.apiKey 和各 provider 的专属环境变量，
 * 导致明明配好了却报 "not set"。这里复用真正的 `resolveApiKey`（与运行时
 * 取 key 完全一致）判定有无，并按同样的优先级推断来源用于展示。
 */
export async function checkApiKey(
  settings: Settings,
  storage: CredentialStorage = new CredentialStorage(),
): Promise<ApiKeyCheck> {
  const key = await resolveApiKey(settings, undefined, storage);
  if (!key) return { ok: false, source: "not set" };

  // 与 resolveApiKey 相同的优先级，仅用于推断展示来源。
  if (settings.apiKey) return { ok: true, source: "settings.json" };

  const providerName = settings.provider;
  if (providerName) {
    if (providerName === "codex") {
      const state = await describeCodexAuthState();
      if (state.configured) return { ok: true, source: `codex_subscription [${state.source}]` };
      return { ok: false, source: `codex_subscription ${state.state}` };
    }
    if (await storage.loadApiKey(providerName)) {
      return { ok: true, source: `credentials.json [${providerName}]` };
    }
    const spec = findByName(providerName);
    if (spec?.envKey && process.env[spec.envKey]) {
      return { ok: true, source: `env ${spec.envKey}` };
    }
  }

  const detected = detectProvider(settings.model, undefined, settings.baseUrl);
  if (detected) {
    if (await storage.loadApiKey(detected.name)) {
      return { ok: true, source: `credentials.json [${detected.name}]` };
    }
    if (detected.envKey && process.env[detected.envKey]) {
      return { ok: true, source: `env ${detected.envKey}` };
    }
  }

  if (process.env.ANTHROPIC_API_KEY) return { ok: true, source: "env ANTHROPIC_API_KEY" };
  if (process.env.OPENAI_API_KEY) return { ok: true, source: "env OPENAI_API_KEY" };
  return { ok: true, source: "found" };
}
