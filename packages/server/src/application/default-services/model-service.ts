import {
  PROVIDERS,
  createModelCatalogService,
  findByName,
  type ModelsDevCatalog,
  type ModelsDevModel,
} from "@openharness/api";
import { CredentialStorage, describeCodexAuthState } from "@openharness/auth";

import type {
  ModelInfo,
  ModelProviderInfo,
  ModelService,
} from "../settings-api.js";
import { readCurrentSettings, type DaemonSettingsRef } from "./shared.js";
import { readCatalogProvider } from "./catalog-provider-mapping.js";
import {
  modelInputCapabilities,
  normalizeInputSupport,
} from "../attachments/routing/attachment-capabilities.js";

export function createDefaultModelService(
  ref?: DaemonSettingsRef,
): ModelService {
  const storage = new CredentialStorage();
  const catalogService = createModelCatalogService();
  return {
    async list(): Promise<ModelProviderInfo[]> {
      const catalog = await catalogService.load();
      const result: ModelProviderInfo[] = [];

      for (const spec of PROVIDERS) {
        if (!(await isProviderConnected(spec.name, storage))) continue;
        const catalogProvider = readCatalogProvider(catalog, spec.name);
        if (!catalogProvider?.models) continue;

        const models = Object.entries(catalogProvider.models)
          .filter(
            ([, model]) =>
              model.status !== "deprecated" && model.status !== "alpha",
          )
          .map(([id, model]) =>
            toModelInfo(spec.name, spec.displayName, model.id ?? id, model),
          );
        if (models.length === 0) continue;

        result.push({
          name: spec.name,
          displayName: spec.displayName,
          models,
        });
      }

      const current = ref ? await readCurrentSettings(ref) : undefined;
      for (const provider of current?.customProviders ?? []) {
        const catalogModels =
          provider.source === "models.dev"
            ? indexCatalogModels(catalog, provider.id)
            : undefined;
        result.push({
          name: provider.id,
          displayName: provider.displayName,
          models: provider.models.map((model) => {
            const catalogModel = catalogModels?.get(model.id);
            if (catalogModel) {
              return toModelInfo(
                provider.id,
                provider.displayName,
                model.id,
                catalogModel,
              );
            }
            return {
              id: model.id,
              label: model.displayName,
              provider: provider.displayName,
              providerName: provider.id,
              status: "active" as const,
              inputCapabilities: {
                image: normalizeInputSupport(model.imageInputSupport),
              },
            };
          }),
        });
      }

      return result;
    },
  };
}

function modelHint(model: ModelsDevModel): string | undefined {
  const cost = model.cost;
  if (cost && cost.input === 0 && cost.output === 0) return "Free";
  return undefined;
}

function modelVision(model: ModelsDevModel): boolean | undefined {
  const input = model.modalities?.input;
  if (!input) return undefined;
  return (
    input.includes("image") || input.includes("pdf") || input.includes("video")
  );
}

/** Index catalog models the same way direct-api-key providers expose their ids. */
function indexCatalogModels(
  catalog: ModelsDevCatalog,
  providerName: string,
): Map<string, ModelsDevModel> | undefined {
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return undefined;
  const map = new Map<string, ModelsDevModel>();
  for (const [key, model] of Object.entries(provider.models)) {
    const id =
      typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
    map.set(id, model);
  }
  return map;
}

function toModelInfo(
  providerName: string,
  providerDisplayName: string,
  id: string,
  model: ModelsDevModel,
): ModelInfo {
  const inputModalities = model.modalities?.input?.filter(
    (item) => item.trim().length > 0,
  );
  return {
    id,
    label: model.name ?? model.id ?? id,
    provider: providerDisplayName,
    providerName,
    ...(modelHint(model) ? { hint: modelHint(model) } : {}),
    ...(typeof model.limit?.context === "number"
      ? { contextWindow: model.limit.context }
      : {}),
    ...(typeof model.limit?.output === "number"
      ? { outputLimit: model.limit.output }
      : {}),
    ...(typeof model.reasoning === "boolean"
      ? { reasoning: model.reasoning }
      : {}),
    ...(typeof modelVision(model) === "boolean"
      ? { vision: modelVision(model) }
      : {}),
    ...(inputModalities && inputModalities.length > 0
      ? { inputModalities }
      : {}),
    inputCapabilities: modelInputCapabilities(model),
    ...(typeof model.tool_call === "boolean"
      ? { toolCalling: model.tool_call }
      : {}),
    ...(model.status === "beta"
      ? { status: "beta" as const }
      : { status: "active" as const }),
  };
}

async function isProviderConnected(
  providerName: string,
  storage: CredentialStorage,
): Promise<boolean> {
  const spec = findByName(providerName);
  if (!spec) return false;
  if (spec.isLocal) return true;
  if (providerName === "codex")
    return (await describeCodexAuthState()).configured;
  if (await storage.loadApiKey(providerName)) return true;
  return !!(spec.envKey && process.env[spec.envKey]);
}
