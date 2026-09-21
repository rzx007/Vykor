import {
  CODEX_DEFAULT_MODEL,
  createModelCatalogService,
  findByName,
  resolveProviderScopedBaseUrl,
  type ModelsDevCatalog,
} from "@openharness/api";

import type { SettingsService } from "../settings-api.js";
import type { AgentEnvironmentCapabilities } from "@openharness/protocol";
import { catalogProviderModelIds } from "./catalog-provider-mapping.js";
import {
  mergeSettingsPatch,
  readCurrentSettings,
  sanitizeSettings,
  saveSettingsAndRefreshRef,
  isRecord,
  type DaemonSettingsRef,
} from "./shared.js";

/** Changing these requires closing all runtimes; blocked while any run is active. */
const HARD_RUNTIME_RESTART_KEYS = new Set([
  "provider",
  "baseUrl",
  "apiFormat",
  "apiKey",
  "mcpServers",
  "plugins",
  "agentEnvironment",
]);

/**
 * Prompt / turn behavior. Safe to persist while a run is active; warm agents are
 * invalidated so the next task picks up the new values.
 */
const SOFT_RUNTIME_INVALIDATE_KEYS = new Set([
  "maxTurns",
  "effort",
  "fastMode",
  "workStyle",
]);

export type SettingsRuntimeImpact = "restart" | "invalidate" | "none";

export interface AgentEnvironmentService {
  capabilities(): Promise<AgentEnvironmentCapabilities>;
  validate(kind: "native" | "wsl"): Promise<void>;
}

export function settingsPatchRuntimeImpact(
  patch: Record<string, unknown>,
): SettingsRuntimeImpact {
  const keys = new Set<string>();
  for (const key of Object.keys(patch)) {
    if (key === "path" || key === "value") continue;
    keys.add(key);
  }
  if (typeof patch.path === "string" && patch.path.trim()) {
    keys.add(patch.path.split(".")[0]!);
  }
  if ([...keys].some((key) => HARD_RUNTIME_RESTART_KEYS.has(key))) {
    return "restart";
  }
  if ([...keys].some((key) => SOFT_RUNTIME_INVALIDATE_KEYS.has(key))) {
    return "invalidate";
  }
  return "none";
}

export function createDefaultSettingsService(
  ref: DaemonSettingsRef,
  options: { agentEnvironment?: AgentEnvironmentService } = {},
): SettingsService {
  const catalogService = createModelCatalogService();
  return {
    ...(options.agentEnvironment
      ? {
          agentEnvironmentCapabilities: () =>
            options.agentEnvironment!.capabilities(),
        }
      : {}),
    async get() {
      return sanitizeSettings(await readCurrentSettings(ref));
    },
    async patch(patch) {
      await readCurrentSettings(ref);
      assertCurrentEnvironmentPatch(patch);
      if (
        "workStyle" in patch &&
        patch.workStyle !== "practical" &&
        patch.workStyle !== "efficient"
      ) {
        throw new Error("Unknown work style. Use practical or efficient.");
      }
      let effectivePatch = patch;
      if (typeof patch.path === "string" && "value" in patch) {
        const coerced = coerceConfigValue(patch.path, String(patch.value));
        if (coerced === undefined)
          throw new Error(`Unknown or invalid config key/value: ${patch.path}`);
        effectivePatch = buildSettingsPatch(
          sanitizeSettings(ref.current),
          patch.path,
          coerced,
        );
        assertCurrentEnvironmentPatch(effectivePatch);
      }

      const next = mergeSettingsPatch(ref.current, effectivePatch);
      const environmentKind = readAgentEnvironmentKind(effectivePatch);
      if (environmentKind && options.agentEnvironment) {
        await options.agentEnvironment.validate(environmentKind);
      }
      if (typeof effectivePatch.provider === "string") {
        next.provider = effectivePatch.provider;
        next.baseUrl = resolveProviderScopedBaseUrl(
          next.baseUrl,
          effectivePatch.provider,
        );
        if (effectivePatch.provider !== "auto") {
          next.model = await resolveProviderModelSelection({
            provider: effectivePatch.provider,
            requestedModel:
              typeof effectivePatch.model === "string"
                ? effectivePatch.model
                : undefined,
            currentModel:
              typeof next.model === "string" ? next.model : undefined,
            customProviders: next.customProviders,
            catalog: await catalogService.load(),
          });
        }
      }
      if (effectivePatch.provider === "auto") {
        delete next.provider;
      }
      await saveSettingsAndRefreshRef(ref, next);
      const impact = settingsPatchRuntimeImpact(effectivePatch);
      return {
        settings: sanitizeSettings(next),
        restartRuntimes: impact === "restart",
        invalidateRuntimes: impact === "invalidate",
      };
    },
  };
}

function readAgentEnvironmentKind(
  patch: Record<string, unknown>,
): "native" | "wsl" | undefined {
  if (!isRecord(patch.agentEnvironment)) return undefined;
  const kind = patch.agentEnvironment.kind;
  return kind === "native" || kind === "wsl" ? kind : undefined;
}

function assertCurrentEnvironmentPatch(patch: Record<string, unknown>): void {
  const path = typeof patch.path === "string" ? patch.path : undefined;
  if (
    path &&
    [
      "sandbox.backend",
      "sandbox.docker",
      "sandbox.runtime",
      "terminal.dockerShell",
    ].some((field) => path === field || path.startsWith(`${field}.`))
  ) {
    throw new Error(`Unsupported removed runtime setting: ${path}`);
  }
  const sandbox = isRecord(patch.sandbox) ? patch.sandbox : undefined;
  for (const field of ["backend", "docker", "runtime"]) {
    if (sandbox && field in sandbox)
      throw new Error(`Unsupported removed runtime setting: sandbox.${field}`);
  }
  const terminal = isRecord(patch.terminal) ? patch.terminal : undefined;
  if (terminal && "dockerShell" in terminal)
    throw new Error(
      "Unsupported removed runtime setting: terminal.dockerShell",
    );
  if (patch.agentEnvironment !== undefined) {
    if (
      !isRecord(patch.agentEnvironment) ||
      (patch.agentEnvironment.kind !== "native" &&
        patch.agentEnvironment.kind !== "wsl")
    ) {
      throw new Error("agentEnvironment.kind must be native or wsl");
    }
  }
}

async function resolveProviderModelSelection(input: {
  provider: string;
  requestedModel?: string;
  currentModel?: string;
  customProviders?: unknown;
  catalog: ModelsDevCatalog;
}): Promise<string> {
  if (input.provider === "codex") {
    return input.requestedModel || input.currentModel || CODEX_DEFAULT_MODEL;
  }
  const customModelIds = customProviderModelIds(
    input.customProviders,
    input.provider,
  );
  if (customModelIds.length > 0) {
    return pickPreferredModel(
      customModelIds,
      input.requestedModel,
      input.currentModel,
      input.provider,
    );
  }

  const catalogModelIds = catalogProviderModelIds(
    input.catalog,
    input.provider,
  );
  if (catalogModelIds.length > 0) {
    return pickPreferredModel(
      catalogModelIds,
      input.requestedModel,
      input.currentModel,
      input.provider,
    );
  }

  if (!findByName(input.provider)) {
    throw new Error(`未知供应商：${input.provider}`);
  }
  throw new Error(`供应商 ${input.provider} 当前没有可用模型，无法设为默认。`);
}

function pickPreferredModel(
  models: string[],
  requestedModel: string | undefined,
  currentModel: string | undefined,
  provider: string,
): string {
  if (requestedModel && models.includes(requestedModel)) return requestedModel;
  if (requestedModel) {
    throw new Error(`模型 ${requestedModel} 不属于 provider ${provider}。`);
  }
  if (currentModel && models.includes(currentModel)) return currentModel;
  return models[0]!;
}

function customProviderModelIds(
  customProviders: unknown,
  providerName: string,
): string[] {
  if (!Array.isArray(customProviders)) return [];
  const match = customProviders.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).id === providerName,
  );
  if (!match || typeof match !== "object") return [];
  const models = (match as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const id = (model as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function coerceConfigValue(key: string, value: string): unknown {
  if (
    [
      "model",
      "apiFormat",
      "baseUrl",
      "systemPrompt",
      "theme",
      "outputStyle",
      "effort",
      "provider",
    ].includes(key)
  ) {
    return value;
  }
  if (["maxTurns", "maxTokens", "passes"].includes(key)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (
    [
      "verbose",
      "fastMode",
      "showReasoning",
      "plugins.enabled",
      "memory.enabled",
      "memory.sessionMemoryEnabled",
      "memory.autoExtractEnabled",
      "memory.autoDreamEnabled",
      "daemon.autoStart",
    ].includes(key)
  ) {
    if (value === "true" || value === "on") return true;
    if (value === "false" || value === "off") return false;
    return undefined;
  }
  if (
    [
      "memory.maxFiles",
      "memory.maxEntrypointLines",
      "memory.autoDreamMinHours",
      "memory.autoDreamMinSessions",
    ].includes(key)
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (key === "permission.mode") {
    return ["default", "plan", "full_auto"].includes(value) ? value : undefined;
  }
  return value;
}

function buildSettingsPatch(
  settings: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const [head, child] = key.split(".");
  if (!head || !child) return { [key]: value };
  const current = isRecord(settings[head]) ? settings[head] : {};
  return { [head]: { ...current, [child]: value } };
}
