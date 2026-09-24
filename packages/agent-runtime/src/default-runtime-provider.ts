import type { Settings, StreamingMessageClient } from "@vykor/core";
import {
  AnthropicClient,
  CodexSubscriptionClient,
  VYKOR_USER_AGENT,
  OpenAICompatibleClient,
  detectProvider,
  detectProviderFromEnv,
  expandRequestHeaderTemplates,
  findByName,
  resolveProviderScopedBaseUrl,
} from "@vykor/api";
import type { BackendType, ProviderSpec } from "@vykor/api";
import { CredentialStorage, resolveApiKey } from "@vykor/auth";

import type { VykorAgentConfiguration } from "./agent-options.js";

export interface CustomProviderRuntimeConfig {
  backendType: "openai_compat";
  baseURL: string;
  headers?: Record<string, string>;
}

export function resolveCustomProviderRuntime(
  settings: Settings,
  providerName: string | undefined,
): CustomProviderRuntimeConfig | undefined {
  if (!providerName) return undefined;
  const provider = settings.customProviders?.find((item) => item.id === providerName);
  if (!provider) return undefined;
  return {
    backendType: "openai_compat",
    baseURL: provider.baseUrl,
    ...(provider.headers ? { headers: provider.headers } : {}),
  };
}

export function resolveRuntimeModel(
  settings: Settings,
  overrides: { model?: string | undefined },
): string {
  return overrides.model ?? settings.model;
}

/**
 * 解析并创建 API 客户端实例。
 *
 * 该函数根据提供的设置、覆盖选项和存储机制，确定正确的 API 密钥、基础 URL、提供商规范以及后端类型，
 * 最终返回相应的流式消息客户端实例。
 */
export async function resolveApiClient(
  settings: Settings,
  configuration?: VykorAgentConfiguration,
  storage?: CredentialStorage,
  sessionId?: string,
): Promise<StreamingMessageClient> {
  const resolvedStorage = storage ?? new CredentialStorage();
  const apiKey = await resolveApiKey(settings, configuration, resolvedStorage);
  const providerName = configuration?.provider ?? settings.provider;
  const customProvider = resolveCustomProviderRuntime(settings, providerName);
  const rawBaseURL = configuration?.baseUrl === ""
    ? customProvider?.baseURL
    : configuration?.baseUrl ?? customProvider?.baseURL
      ?? (providerName === settings.provider ? settings.baseUrl : undefined);
  const baseURL = providerName && !customProvider
    ? resolveProviderScopedBaseUrl(rawBaseURL, providerName)
    : rawBaseURL;
  const runtimeModel = resolveRuntimeModel(settings, configuration ?? {});
  const requestHeaders = customProvider?.headers
    ? expandRequestHeaderTemplates(customProvider.headers, {
        sessionId,
        userAgent: VYKOR_USER_AGENT,
      })
    : undefined;

  // 按优先级顺序解析提供商规范：首先尝试通过名称查找，其次基于模型和凭据检测，最后尝试从环境变量检测
  let spec: ProviderSpec | undefined;
  if (providerName) {
    spec = findByName(providerName);
  }
  if (!spec) {
    spec = detectProvider(runtimeModel, apiKey, baseURL);
  }
  if (!spec) {
    spec = detectProviderFromEnv(process.env);
  }

  // 确定后端类型：优先使用提供商规范中的类型，否则根据 API 格式推断
  const backendType: BackendType =
    customProvider?.backendType ?? spec?.backendType ??
    resolveBackendFromFormat(configuration?.apiFormat ?? settings.apiFormat);

  switch (backendType) {
    case "codex":
      return new CodexSubscriptionClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: runtimeModel,
      });
    case "openai_compat":
      return new OpenAICompatibleClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: runtimeModel,
        ...(requestHeaders ? { headers: requestHeaders } : {}),
      });
    case "anthropic":
    default:
      return new AnthropicClient({
        apiKey,
        baseURL,
      });
  }
}

function resolveBackendFromFormat(format: string): BackendType {
  switch (format) {
    case "openai":
      return "openai_compat";
    default:
      return "anthropic";
  }
}
