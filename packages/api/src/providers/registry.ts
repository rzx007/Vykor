import type { InputSupport } from "@vykor/core";

export type BackendType = "anthropic" | "openai_compat" | "codex";

export interface ProviderInputCapabilities {
  image: InputSupport;
  imageMediaTypes: readonly string[];
}

export const NATIVE_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type NativeImageMediaType = (typeof NATIVE_IMAGE_MEDIA_TYPES)[number];

export function assertNativeImageMediaType(
  mediaType: string,
): asserts mediaType is NativeImageMediaType {
  if (!(NATIVE_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new Error(`Unsupported image media type: ${mediaType}`);
  }
}

/** Capabilities of the request adapter, independent from any concrete model. */
export function providerInputCapabilities(
  _backendType: BackendType,
): ProviderInputCapabilities {
  return { image: "native", imageMediaTypes: [...NATIVE_IMAGE_MEDIA_TYPES] };
}

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface ProviderSpec {
  name: string;
  keywords: string[];
  envKey: string;
  displayName: string;
  backendType: BackendType;
  defaultBaseURL: string;
  detectByKeyPrefix: string;
  detectByBaseKeyword: string;
  isGateway: boolean;
  isLocal: boolean;
  isOAuth: boolean;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    name: "openrouter",
    keywords: ["openrouter"],
    envKey: "OPENROUTER_API_KEY",
    displayName: "OpenRouter",
    backendType: "openai_compat",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    detectByKeyPrefix: "sk-or-",
    detectByBaseKeyword: "openrouter",
    isGateway: true,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "aihubmix",
    keywords: ["aihubmix"],
    envKey: "OPENAI_API_KEY",
    displayName: "AiHubMix",
    backendType: "openai_compat",
    defaultBaseURL: "https://aihubmix.com/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "aihubmix",
    isGateway: true,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "siliconflow",
    keywords: ["siliconflow"],
    envKey: "OPENAI_API_KEY",
    displayName: "SiliconFlow",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.siliconflow.cn/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "siliconflow",
    isGateway: true,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "volcengine",
    keywords: ["volcengine", "volces", "ark"],
    envKey: "OPENAI_API_KEY",
    displayName: "VolcEngine",
    backendType: "openai_compat",
    defaultBaseURL: "https://ark.cn-beijing.volces.com/api/v3",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "volces",
    isGateway: true,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "anthropic",
    keywords: ["anthropic", "claude"],
    envKey: "ANTHROPIC_API_KEY",
    displayName: "Anthropic",
    backendType: "anthropic",
    defaultBaseURL: "",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "openai",
    keywords: ["openai", "gpt", "o1", "o3", "o4"],
    envKey: "OPENAI_API_KEY",
    displayName: "OpenAI",
    backendType: "openai_compat",
    defaultBaseURL: "",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "codex",
    keywords: ["codex", "gpt", "o1", "o3", "o4"],
    envKey: "",
    displayName: "Codex Subscription",
    backendType: "codex",
    defaultBaseURL: "https://chatgpt.com/backend-api",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "chatgpt.com/backend-api",
    isGateway: false,
    isLocal: false,
    isOAuth: true,
  },
  {
    name: "deepseek",
    keywords: ["deepseek"],
    envKey: "DEEPSEEK_API_KEY",
    displayName: "DeepSeek",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.deepseek.com/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "deepseek",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "gemini",
    keywords: ["gemini"],
    envKey: "GEMINI_API_KEY",
    displayName: "Gemini",
    backendType: "openai_compat",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "googleapis",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "dashscope",
    keywords: ["qwen", "dashscope"],
    envKey: "DASHSCOPE_API_KEY",
    displayName: "DashScope",
    backendType: "openai_compat",
    defaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "dashscope",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "moonshot",
    keywords: ["moonshot", "kimi"],
    envKey: "MOONSHOT_API_KEY",
    displayName: "Moonshot",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.moonshot.ai/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "moonshot",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "minimax",
    keywords: ["minimax"],
    envKey: "MINIMAX_API_KEY",
    displayName: "MiniMax",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.minimax.io/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "minimax",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "zhipu",
    keywords: ["zhipu", "glm", "chatglm"],
    envKey: "ZHIPUAI_API_KEY",
    displayName: "Zhipu AI",
    backendType: "openai_compat",
    defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "bigmodel",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "groq",
    keywords: ["groq"],
    envKey: "GROQ_API_KEY",
    displayName: "Groq",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.groq.com/openai/v1",
    detectByKeyPrefix: "gsk_",
    detectByBaseKeyword: "groq",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "mistral",
    keywords: ["mistral", "mixtral", "codestral"],
    envKey: "MISTRAL_API_KEY",
    displayName: "Mistral",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.mistral.ai/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "mistral",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "stepfun",
    keywords: ["step-", "stepfun"],
    envKey: "STEPFUN_API_KEY",
    displayName: "StepFun",
    backendType: "openai_compat",
    defaultBaseURL: "https://api.stepfun.com/v1",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "stepfun",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "baidu",
    keywords: ["ernie", "baidu"],
    envKey: "QIANFAN_ACCESS_KEY",
    displayName: "Baidu",
    backendType: "openai_compat",
    defaultBaseURL: "https://qianfan.baidubce.com/v2",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "baidubce",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "bedrock",
    keywords: ["bedrock"],
    envKey: "AWS_ACCESS_KEY_ID",
    displayName: "AWS Bedrock",
    backendType: "openai_compat",
    defaultBaseURL: "",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "bedrock",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
  {
    name: "vertex",
    keywords: ["vertex"],
    envKey: "GOOGLE_APPLICATION_CREDENTIALS",
    displayName: "Vertex AI",
    backendType: "openai_compat",
    defaultBaseURL: "",
    detectByKeyPrefix: "",
    detectByBaseKeyword: "aiplatform",
    isGateway: false,
    isLocal: false,
    isOAuth: false,
  },
];

export function findByName(name: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.name === name);
}

function matchByModel(model: string): ProviderSpec | undefined {
  const modelLower = model.toLowerCase();
  const modelNormalized = modelLower.replace(/-/g, "_");
  const modelPrefix = modelLower.includes("/") ? modelLower.split("/")[0]! : "";
  const normalizedPrefix = modelPrefix.replace(/-/g, "_");

  const stdSpecs = PROVIDERS.filter((s) => !s.isLocal && !s.isOAuth);

  for (const spec of stdSpecs) {
    if (modelPrefix && normalizedPrefix === spec.name) return spec;
  }

  for (const spec of stdSpecs) {
    if (
      spec.keywords.some(
        (kw) => modelLower.includes(kw) || modelNormalized.includes(kw.replace(/-/g, "_"))
      )
    ) {
      return spec;
    }
  }
  return undefined;
}

export function detectProvider(
  model: string,
  apiKey?: string,
  baseURL?: string
): ProviderSpec | undefined {
  if (apiKey) {
    for (const spec of PROVIDERS) {
      if (spec.detectByKeyPrefix && apiKey.startsWith(spec.detectByKeyPrefix)) {
        return spec;
      }
    }
  }

  if (baseURL) {
    const baseLower = baseURL.toLowerCase();
    for (const spec of PROVIDERS) {
      if (spec.detectByBaseKeyword && baseLower.includes(spec.detectByBaseKeyword)) {
        return spec;
      }
    }
  }

  if (model) {
    return matchByModel(model);
  }

  return undefined;
}

export function detectProviderFromEnv(
  env: NodeJS.ProcessEnv
): ProviderSpec | undefined {
  const seen = new Set<string>();
  for (const spec of PROVIDERS) {
    if (spec.isOAuth || spec.isLocal || spec.isGateway) continue;
    if (spec.envKey && env[spec.envKey] && !seen.has(spec.envKey)) {
      seen.add(spec.envKey);
      return spec;
    }
  }
  for (const spec of PROVIDERS) {
    if (spec.isOAuth || spec.isLocal) continue;
    if (spec.envKey && env[spec.envKey]) return spec;
  }
  return undefined;
}

export function resolveProviderScopedBaseUrl(
  baseURL: string | undefined,
  providerName: string | undefined,
): string | undefined {
  if (!baseURL || !providerName) return baseURL;
  const detected = detectProvider("", undefined, baseURL);
  if (detected && detected.name !== providerName) return undefined;
  return baseURL;
}
