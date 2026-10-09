import type { ModelsDevCatalog } from "@vykor/api";
import type { CustomProviderModelSettings, CustomProviderSettings } from "@vykor/core";

import {
  catalogModelContextWindow,
  catalogModelOutputLimit,
  findCatalogModelById,
  positiveLimit,
} from "./catalog-provider-mapping.js";

/** 对应模型目录 models.dev 的 `limit.context` / `limit.output` 两个字段。 */
export type ModelLimitKind = "context" | "output";

export interface ModelLimitResolutionInput {
  catalog: ModelsDevCatalog;
  customProviders?: CustomProviderSettings[] | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

/**
 * 解析一个模型实际生效的上下文窗口或最大输出，取值顺序：
 *
 * 1. 自定义供应商里用户自己填的值（优先级最高）；
 * 2. 模型目录中同供应商的精确命中；
 * 3. 自定义供应商的模型，按模型 id 到目录里跨供应商模糊匹配
 *    （忽略大小写与连字符，先到先得）；
 * 4. 都没有则返回 undefined，交给调用方的默认值。
 *
 * 第 3 步只对自定义供应商生效，避免影响内置供应商的既有行为。
 */
export function resolveModelLimit(
  kind: ModelLimitKind,
  input: ModelLimitResolutionInput,
): number | undefined {
  const provider = input.provider?.trim();
  const model = input.model?.trim();
  if (!provider || !model) return undefined;

  const custom = customModelEntry(input.customProviders, provider, model);
  const declared = positiveLimit(
    kind === "context" ? custom?.contextWindow : custom?.maxOutputTokens,
  );
  if (declared !== undefined) return declared;

  const fromCatalogProvider =
    kind === "context"
      ? catalogModelContextWindow(input.catalog, provider, model)
      : catalogModelOutputLimit(input.catalog, provider, model);
  if (fromCatalogProvider !== undefined) return fromCatalogProvider;

  if (!custom) return undefined;
  return positiveLimit(findCatalogModelById(input.catalog, model)?.limit?.[kind]);
}

function customModelEntry(
  customProviders: CustomProviderSettings[] | undefined,
  provider: string,
  model: string,
): CustomProviderModelSettings | undefined {
  return customProviders
    ?.find((item) => item.id === provider)
    ?.models.find((item) => item.id === model);
}
