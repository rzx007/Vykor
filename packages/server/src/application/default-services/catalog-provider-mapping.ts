import type {
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevProvider,
} from "@vykor/api";

const CATALOG_PROVIDER_ALIASES: Record<string, string[]> = {
  bedrock: ["amazon-bedrock"],
  dashscope: ["dashscope", "alibaba"],
  gemini: ["gemini", "google"],
  moonshot: ["moonshotai", "moonshotai-cn"],
  vertex: ["google-vertex", "vertex"],
  zhipu: ["zhipuai", "zai", "zhipu", "z-ai"],
};

export function readCatalogProvider(
  catalog: ModelsDevCatalog,
  providerName: string,
): ModelsDevProvider | undefined {
  for (const key of catalogProviderKeys(providerName)) {
    const provider = catalog[key];
    if (provider?.models && Object.keys(provider.models).length > 0) {
      return provider;
    }
  }
  return undefined;
}

export function catalogProviderModelIds(
  catalog: ModelsDevCatalog,
  providerName: string,
): string[] {
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return [];
  return Object.entries(provider.models)
    .filter(
      ([, model]) => model.status !== "deprecated" && model.status !== "alpha",
    )
    .map(([id, model]) =>
      typeof model.id === "string" && model.id.trim() ? model.id.trim() : id,
    );
}

function catalogProviderKeys(providerName: string): string[] {
  return [
    providerName,
    ...(CATALOG_PROVIDER_ALIASES[providerName] ?? []),
  ].filter((item, index, items) => item && items.indexOf(item) === index);
}

export function reasoningEffortsFromModel(
  model: Pick<ModelsDevModel, "reasoning_options">,
): string[] | undefined {
  const option = model.reasoning_options?.find((item) => item.type === "effort");
  const values = option?.values
    ?.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return values && values.length > 0 ? values : undefined;
}

export function catalogModelReasoningEfforts(
  catalog: ModelsDevCatalog,
  providerName: string | undefined,
  modelId: string,
): string[] | undefined {
  if (!providerName) return undefined;
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return undefined;
  const entry = Object.entries(provider.models).find(([key, model]) => {
    const id =
      typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
    return id === modelId;
  });
  return entry ? reasoningEffortsFromModel(entry[1]) : undefined;
}
