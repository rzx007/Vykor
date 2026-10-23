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

export function catalogModelEntry(
  catalog: ModelsDevCatalog,
  providerName: string,
  modelId: string,
): ModelsDevModel | undefined {
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return undefined;
  const entry = Object.entries(provider.models).find(([key, model]) => {
    const id =
      typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
    return id === modelId;
  });
  return entry?.[1];
}

export function positiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function catalogModelContextWindow(
  catalog: ModelsDevCatalog,
  providerName: string,
  modelId: string,
): number | undefined {
  return positiveLimit(catalogModelEntry(catalog, providerName, modelId)?.limit?.context);
}

export function catalogModelOutputLimit(
  catalog: ModelsDevCatalog,
  providerName: string,
  modelId: string,
): number | undefined {
  return positiveLimit(catalogModelEntry(catalog, providerName, modelId)?.limit?.output);
}

/**
 * 跨供应商匹配模型时使用的比较键：忽略大小写和连字符，
 * 让 `gpt-4o`、`GPT-4O`、`gpt4o` 视为同一个模型。
 */
function modelIdKey(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * 按模型 id 在整个目录里找第一个命中的模型（先到先得，忽略大小写和连字符）。
 *
 * 用途：自定义供应商本身不在目录里，它的模型仍然可以借用同名模型
 * （例如 `claude-sonnet-4-5`）的上下文窗口和最大输出。
 * 已弃用（deprecated）和预览期（alpha）的条目会跳过，
 * 与 catalogProviderModelIds 对目录的过滤口径保持一致。
 */
export function findCatalogModelById(
  catalog: ModelsDevCatalog,
  modelId: string,
): ModelsDevModel | undefined {
  const target = modelIdKey(modelId.trim());
  if (!target) return undefined;
  for (const provider of Object.values(catalog)) {
    if (!provider?.models) continue;
    for (const [key, model] of Object.entries(provider.models)) {
      if (model.status === "deprecated" || model.status === "alpha") continue;
      const id =
        typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
      if (modelIdKey(id) === target || modelIdKey(key) === target) {
        return model;
      }
    }
  }
  return undefined;
}

export function catalogModelReasoningEfforts(
  catalog: ModelsDevCatalog,
  providerName: string | undefined,
  modelId: string,
): string[] | undefined {
  if (!providerName) return undefined;
  const model = catalogModelEntry(catalog, providerName, modelId);
  return model ? reasoningEffortsFromModel(model) : undefined;
}
