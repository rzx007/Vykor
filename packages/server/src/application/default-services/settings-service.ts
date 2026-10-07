import {
  CODEX_DEFAULT_MODEL,
  createModelCatalogService,
  detectProvider,
  findByName,
  resolveProviderScopedBaseUrl,
  type ModelsDevCatalog,
} from "@vykor/api";

import type { SettingsService } from "../settings-api.js";
import type { AgentEnvironmentCapabilities } from "@vykor/protocol";
import { loadSettings, parsePermissionSettings, type AgentEnvironmentSettings, type Settings } from "@vykor/core";
import { validateIsolationConfiguration } from "../../permissions/settings-management.js";
import { normalizeSandboxConfig } from "@vykor/sandbox";
import { importPortableSettings, parsePortableSettings, type PortableSettings } from "../../settings-transfer.js";
import { validateRuntimeEnvironmentConfig } from "../../runtime/runtime-settings.js";
import { validateRequestSelection } from "../session/request-selection-validation.js";
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
  "importConfiguration",
]);

/**
 * Prompt / turn behavior. Safe to persist while a run is active; warm agents are
 * invalidated so the next task picks up the new values.
 */
const SOFT_RUNTIME_INVALIDATE_KEYS = new Set([
  "maxTurns",
  "outputTokenMax",
  "effort",
  "fastMode",
  "workStyle",
  "systemPrompt",
  "memory",
  "permission",
  "sandbox",
  "runtimeEnvironmentChanged",
]);

export type SettingsRuntimeImpact = "restart" | "invalidate" | "none";

export interface AgentEnvironmentService {
  capabilities(): Promise<AgentEnvironmentCapabilities>;
  validate(kind: "native" | "wsl"): Promise<void>;
  active?(): import("@vykor/core").AgentEnvironmentSettings | undefined;
  kindOverride?(): "native" | "wsl" | undefined;
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
      return { ...sanitizeSettings(await readCurrentSettings(ref)),
        maxTurnsEditable: process.env.VYKOR_MAX_TURNS === undefined,
        ...(process.env.VYKOR_MAX_TURNS !== undefined ? { maxTurnsReason: "任务轮数由启动环境变量固定，请调整 VYKOR_MAX_TURNS 后重启后台。" } : {}),
        ...(options.agentEnvironment?.active?.() ? { runtimeEnvironmentActive: options.agentEnvironment.active() } : {}),
        ...(options.agentEnvironment?.kindOverride?.() ? { runtimeEnvironmentKindOverride: options.agentEnvironment.kindOverride() } : {}) };
    },
    async patch(input) {
      const { expectedPermission, expectedSandbox, expectedAutoReviewMode, expectedMaxTurns, runtimeEnvironmentChanged, ...patch } = input;
      if (expectedMaxTurns !== undefined) {
        if (!Number.isSafeInteger(expectedMaxTurns) || Number(expectedMaxTurns) < 1 || !Number.isSafeInteger(patch.maxTurns) || Number(patch.maxTurns) < 1 || Number(patch.maxTurns) > 1000) throw new Error("任务轮数必须是 1–1000 的整数，并包含读取时的原值。");
        if (process.env.VYKOR_MAX_TURNS !== undefined) throw new Error("任务轮数由启动环境变量固定，不能通过设置页修改。");
      }
      if (runtimeEnvironmentChanged !== undefined && typeof runtimeEnvironmentChanged !== "boolean") throw new Error("运行环境刷新标记无效。");
      if (expectedAutoReviewMode !== undefined && expectedAutoReviewMode !== "off" && expectedAutoReviewMode !== "risk_based") throw new Error("完成后检查原值无效。");
      await readCurrentSettings(ref);
      if (Object.keys(patch).length === 0) return { settings: sanitizeSettings(ref.current), invalidateRuntimes: runtimeEnvironmentChanged === true };
      if (input.importConfiguration !== undefined) {
        if (Object.keys(input).some(key => key !== "importConfiguration") || !isRecord(input.importConfiguration)) throw new Error("配置导入请求无效。");
        const transfer = input.importConfiguration;
        if (!Array.isArray(transfer.categories) || transfer.categories.some(category => typeof category !== "string") || !isRecord(transfer.expected)) throw new Error("配置导入必须包含分类和预览原值。");
        const file = parsePortableSettings(transfer.value);
        const categories = transfer.categories as string[];
        const saved = await loadSettings(undefined, { includeEnvironment: false });
        const validationDependencies: Partial<Pick<Settings, "sandbox" | "customProviders">> = {};
        const environment = categories.includes("environment") ? file.groups.environment?.agentEnvironment : undefined;
        if (environment) {
          validationDependencies.sandbox = saved.sandbox;
          await validateRuntimeEnvironmentConfig(environment as AgentEnvironmentSettings, undefined, ref.current.sandbox?.enabled);
        }
        const model = categories.includes("model") ? file.groups.model : undefined;
        if (model) {
          validationDependencies.customProviders = saved.customProviders;
          const candidate = { ...saved, ...model };
          if (typeof candidate.model !== "string" || !candidate.model.trim() || (typeof candidate.provider === "string" && !candidate.provider.trim())) throw new Error("导入默认模型必须包含有效供应商和模型名称。");
          const disabled = model.modelDisabled ?? (model.model ? false : saved.modelDisabled);
          if (disabled !== true) {
            const provider = candidate.provider && candidate.provider !== "auto" ? candidate.provider : detectProvider(candidate.model)?.name;
            if (!provider) throw new Error("无法确认导入模型的供应商，请明确选择实际配置的供应商。");
            const catalog = await catalogService.load();
            const selected = await resolveProviderModelSelection({ provider, requestedModel: candidate.model, customProviders: saved.customProviders, catalog });
            validateRequestSelection({ catalog, provider, model: selected, effort: candidate.effort, explicitEffort: Object.hasOwn(model, "effort"), customProviders: saved.customProviders });
            candidate.model = selected.trim();
          }
          // Validate and CAS the pair together, including dependencies absent from
          // a partial file. No other category is expanded or overwritten.
          file.groups.model = { ...model, model: candidate.model, ...(candidate.provider ? { provider: candidate.provider } : {}), modelDisabled: disabled === true };
        }
        ref.current = await importPortableSettings(file, categories, transfer.expected as unknown as PortableSettings, validationDependencies);
        ref.current = ref.reload ? await ref.reload() : await loadSettings();
        return { settings: sanitizeSettings(ref.current), restartRuntimes: true };
      }
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
        effectivePatch = buildSettingsPatch(patch.path, coerced);
        assertCurrentEnvironmentPatch(effectivePatch);
      }

      const next = mergeSettingsPatch(await loadSettings(undefined, { includeEnvironment: false }), effectivePatch);
      if (effectivePatch.permission !== undefined && !isRecord(effectivePatch.permission)) throw new Error("权限设置必须是对象。");
      if (effectivePatch.permission !== undefined) next.permission = parsePermissionSettings(next.permission);
      if (effectivePatch.sandbox !== undefined) {
        if (!isRecord(effectivePatch.sandbox)) throw new Error("隔离设置必须是对象。");
        const { backend: _backend, ...sandbox } = normalizeSandboxConfig(next.sandbox);
        next.sandbox = validateIsolationConfiguration(sandbox);
      }
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
      const persistencePatch = typeof effectivePatch.provider === "string"
        ? { ...effectivePatch, provider: next.provider, model: next.model, baseUrl: next.baseUrl }
        : effectivePatch;
      const checkedEdit = expectedPermission !== undefined || expectedSandbox !== undefined || expectedAutoReviewMode !== undefined || expectedMaxTurns !== undefined;
      await saveSettingsAndRefreshRef(ref, persistencePatch, checkedEdit ? {
        ...(expectedPermission !== undefined ? { permission: parsePermissionSettings(expectedPermission) } : {}),
        ...(expectedSandbox !== undefined ? { sandbox: expectedSandbox } : {}),
        ...(expectedAutoReviewMode !== undefined ? { autoReviewMode: expectedAutoReviewMode } : {}),
        ...(expectedMaxTurns !== undefined ? { maxTurns: Number(expectedMaxTurns) } : {}),
      } : undefined);
      const normalImpact = settingsPatchRuntimeImpact(effectivePatch);
      const impact = normalImpact === "none" && runtimeEnvironmentChanged ? "invalidate" : normalImpact;
      return {
        settings: sanitizeSettings(ref.current),
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
  if (["maxTurns", "outputTokenMax", "passes"].includes(key)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (
    [
      "verbose",
      "fastMode",
      "showReasoning",
      "plugins.enabled",
      "plugins.uiEnabled",
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
  key: string,
  value: unknown,
): Record<string, unknown> {
  const [head, child] = key.split(".");
  if (!head || !child) return { [key]: value };
  return { [head]: { [child]: value } };
}
