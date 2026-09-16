export { AnthropicClient } from "./providers/anthropic";
export {
  CodexSubscriptionClient,
  buildCodexHeaders,
  resolveCodexUrl,
} from "./providers/codex";
export { OpenAICompatibleClient } from "./providers/openai";
export {
  OPENCODE_GO_SESSION_HEADER,
  OPENCODE_GO_USER_AGENT,
  OPENCODE_GO_VALIDATION_SESSION_ID,
  buildOpenCodeGoHeaders,
  isOpenCodeGoTarget,
} from "./providers/opencode-go";
export {
  PROVIDERS,
  detectProvider,
  detectProviderFromEnv,
  findByName,
  resolveProviderScopedBaseUrl,
  providerInputCapabilities,
} from "./providers/registry";
export type {
  ProviderSpec,
  ProviderConfig,
  BackendType,
  ProviderInputCapabilities,
} from "./providers/registry";
export {
  CODEX_DEFAULT_MODEL,
  ModelCatalogService,
  createModelCatalogService,
} from "./models/catalog";
export {
  listDirectApiKeyCatalogProviders,
  toDirectApiKeyProvider,
} from "./models/direct-api-key-providers";
export type { DirectApiKeyCatalogProvider } from "./models/direct-api-key-providers";
export type {
  ModelsDevCatalog,
  ModelsDevProvider,
  ModelsDevModel,
  ModelsDevCost,
} from "./models/catalog";

export {
  AuthenticationFailure,
  RateLimitFailure,
  RequestFailure,
} from "./errors";
export {
  OPENHARNESS_USER_AGENT,
  RequestHeaderTemplateError,
  expandRequestHeaderTemplates,
  normalizeRequestHeaderTemplates,
} from "./providers/request-header-templates";
export type { RequestHeaderTemplateContext } from "./providers/request-header-templates";
