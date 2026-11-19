export interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  active: boolean;
  local?: boolean;
  custom?: boolean;
  requiresApiKey?: boolean;
  source?: "builtin" | "catalog" | "custom" | "subscription";
}

export interface CustomProviderInput {
  id: string;
  displayName: string;
  baseUrl: string;
  apiFormat: "openai";
  apiKey?: string;
  models: Array<{
    id: string;
    displayName: string;
    imageInputSupport?: "native" | "unsupported" | "unknown";
    /** 用户自填的上下文窗口（tokens）；留空时服务端按模型 id 查目录。 */
    contextWindow?: number;
    /** 用户自填的最大输出（tokens）；留空时服务端按模型 id 查目录。 */
    maxOutputTokens?: number;
  }>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string | null>;
}

export interface ConnectCatalogProviderInput {
  apiKey: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string | null>;
}

export interface UpdateCatalogProviderHeadersInput {
  headers: Record<string, string>;
}

export interface AuthStatus {
  codex: {
    configured: boolean;
    state: string;
    source: string;
    detail?: string;
    profileLabel?: string;
  };
  storedProviders: string[];
  envProviders: Array<{ name: string; envKey: string }>;
}

export interface OutputStyleInfo {
  name: string;
  content: string;
  source: "builtin" | "user";
}
