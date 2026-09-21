import type { ModelsDevCatalog } from "@openharness/api";
import type { CustomProviderSettings } from "@openharness/core";

import {
  catalogProviderModelIds,
  catalogModelReasoningEfforts,
} from "../default-services/catalog-provider-mapping.js";

export function validateRequestSelection(input: {
  catalog: ModelsDevCatalog;
  provider: string | undefined;
  model: string;
  effort: string | undefined;
  explicitEffort: boolean;
  customProviders?: CustomProviderSettings[];
}): { effort?: string } {
  const model = input.model.trim();
  if (!model) throw new Error("Model is required");
  const custom = input.customProviders?.find((item) => item.id === input.provider);
  const availableModels = custom
    ? custom.models.map((item) => item.id)
    : input.provider
      ? catalogProviderModelIds(input.catalog, input.provider)
      : [];
  if (input.provider && !availableModels.includes(model)) {
    throw new Error(`Model ${model} is not available for provider ${input.provider}`);
  }

  const effort = input.effort?.trim();
  if (!effort) return { effort: "" };
  const allowed = catalogModelReasoningEfforts(
    input.catalog,
    input.provider,
    model,
  );
  if (!allowed?.includes(effort)) {
    if (input.explicitEffort) {
      throw new Error(`Effort ${effort} is not supported by model ${model}`);
    }
    return { effort: "" };
  }
  return { effort };
}
