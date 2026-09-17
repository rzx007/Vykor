import {
  PROVIDERS,
  createModelCatalogService,
  findByName,
  listDirectApiKeyCatalogProviders,
  normalizeRequestHeaderTemplates,
  RequestHeaderTemplateError,
  type DirectApiKeyCatalogProvider,
  type ModelsDevCatalog,
} from "@openharness/api";
import { CredentialStorage } from "@openharness/auth";
import type { CustomProviderSettings, Settings } from "@openharness/core";

import { ApplicationError } from "../../shared/application-error.js";
import type {
  ConnectCatalogProviderInput,
  CustomProviderInput,
  ProviderInfo,
  ProviderService,
} from "../settings-api.js";
import { validateProviderCredential } from "./credential-validation.js";
import { readCatalogProvider } from "./catalog-provider-mapping.js";
import {
  readCurrentSettings,
  saveSettingsAndRefreshRef,
  type DaemonSettingsRef,
} from "./shared.js";

export function createDefaultProviderService(
  ref: DaemonSettingsRef,
): ProviderService {
  const storage = new CredentialStorage();
  const catalogService = createModelCatalogService();
  const rowForCustomProvider = async (
    provider: CustomProviderSettings,
    currentName: string,
  ): Promise<ProviderInfo> => ({
    name: provider.id,
    displayName: provider.displayName,
    hasKey: !!(await storage.loadApiKey(provider.id)),
    active: provider.id === currentName,
    local: false,
    custom: provider.source !== "models.dev",
    requiresApiKey: provider.source === "models.dev",
    source: provider.source === "models.dev" ? "catalog" : "custom",
  });

  const saveCustomProviders = async (
    providers: CustomProviderSettings[],
    patch: Partial<Settings> = {},
  ): Promise<void> => {
    const next = { ...ref.current, ...patch, customProviders: providers };
    await saveSettingsAndRefreshRef(ref, next);
  };

  return {
    async list() {
      const current = await readCurrentSettings(ref);
      const catalog = await catalogService.load();
      const currentName = current.provider ?? "auto";
      const rows: ProviderInfo[] = [];
      const builtinProviders = PROVIDERS.filter((spec) =>
        isSupportedBuiltinProvider(spec.name, catalog),
      );
      for (const spec of builtinProviders) {
        const storedKey = await storage.loadApiKey(spec.name);
        const hasKey =
          !!storedKey || (spec.envKey ? !!process.env[spec.envKey] : false);
        rows.push({
          name: spec.name,
          displayName: spec.displayName,
          hasKey: !!hasKey || !spec.envKey,
          active: spec.name === currentName,
          local: spec.isLocal,
          requiresApiKey: !spec.isOAuth && !spec.isLocal,
          source: spec.isOAuth ? "subscription" : "builtin",
        });
      }
      for (const provider of current.customProviders ?? []) {
        rows.push(await rowForCustomProvider(provider, currentName));
      }
      const claimedCatalogProviders = new Set(
        builtinProviders.flatMap((spec) => {
          const provider = readCatalogProvider(catalog, spec.name);
          return provider ? [provider] : [];
        }),
      );
      const configuredIds = new Set(
        (current.customProviders ?? []).map((item) => item.id),
      );
      for (const provider of listDirectApiKeyCatalogProviders(catalog)) {
        const rawProvider = catalog[provider.catalogId];
        if (
          configuredIds.has(provider.id) ||
          findByName(provider.id) ||
          (rawProvider && claimedCatalogProviders.has(rawProvider))
        ) {
          continue;
        }
        rows.push({
          name: provider.id,
          displayName: provider.displayName,
          hasKey: false,
          active: false,
          local: false,
          requiresApiKey: true,
          source: "catalog",
        });
      }
      return rows;
    },
    async create(input) {
      const current = await readCurrentSettings(ref);
      const provider = normalizeCustomProvider(input);
      if (findByName(provider.id)) {
        throw new ProviderMutationError(
          400,
          `供应商 ID “${provider.id}” 已被内置供应商使用。`,
        );
      }
      if (current.customProviders?.some((item) => item.id === provider.id)) {
        throw new ProviderMutationError(
          409,
          `自定义供应商 “${provider.id}” 已存在。`,
        );
      }
      if (input.apiKey?.trim()) {
        await validateProviderCredential({
          providerName: provider.id,
          providerDisplayName: provider.displayName,
          backendType: "openai_compat",
          apiKey: input.apiKey.trim(),
          baseUrl: provider.baseUrl,
          headers: provider.headers,
        });
      }
      await saveCustomProviders([...(current.customProviders ?? []), provider]);
      if (input.apiKey?.trim())
        await storage.storeApiKey(provider.id, input.apiKey.trim());
      return await rowForCustomProvider(provider, current.provider ?? "auto");
    },
    async update(id, input) {
      const current = await readCurrentSettings(ref);
      const normalizedId = id.trim().toLowerCase();
      const index =
        current.customProviders?.findIndex(
          (item) => item.id === normalizedId,
        ) ?? -1;
      if (index < 0)
        throw new ProviderMutationError(
          404,
          `自定义供应商 “${normalizedId}” 不存在。`,
        );
      if (current.customProviders?.[index]?.source === "models.dev") {
        throw new ProviderMutationError(
          400,
          "models.dev 目录供应商不能作为自定义供应商编辑。",
        );
      }
      const provider = normalizeCustomProvider({ ...input, id: normalizedId });
      const nextProviders = [...(current.customProviders ?? [])];
      nextProviders[index] = provider;
      if (input.apiKey?.trim()) {
        await validateProviderCredential({
          providerName: provider.id,
          providerDisplayName: provider.displayName,
          backendType: "openai_compat",
          apiKey: input.apiKey.trim(),
          baseUrl: provider.baseUrl,
          headers: provider.headers,
        });
      }
      const currentModelStillAvailable = provider.models.some(
        (model) => model.id === current.model,
      );
      await saveCustomProviders(
        nextProviders,
        current.provider === provider.id && !currentModelStillAvailable
          ? { model: provider.models[0]!.id }
          : {},
      );
      if (input.apiKey?.trim())
        await storage.storeApiKey(provider.id, input.apiKey.trim());
      return await rowForCustomProvider(provider, current.provider ?? "auto");
    },
    async remove(id) {
      const current = await readCurrentSettings(ref);
      const normalizedId = id.trim().toLowerCase();
      if (current.provider === normalizedId) {
        throw new ProviderMutationError(
          409,
          "该供应商正在使用中。请先切换到其他供应商，再删除。",
        );
      }
      const providers = current.customProviders ?? [];
      if (!providers.some((item) => item.id === normalizedId)) {
        throw new ProviderMutationError(
          404,
          `自定义供应商 “${normalizedId}” 不存在。`,
        );
      }
      if (
        providers.find((item) => item.id === normalizedId)?.source ===
        "models.dev"
      ) {
        throw new ProviderMutationError(
          400,
          "请使用断开操作移除 models.dev 目录供应商。",
        );
      }
      await saveCustomProviders(
        providers.filter((item) => item.id !== normalizedId),
      );
      await storage.clearProviderCredentials(normalizedId);
    },
    async connectCatalog(id, input) {
      const normalizedId = id.trim().toLowerCase();
      const credential = input.apiKey.trim();
      if (!credential)
        throw new ProviderMutationError(400, "请输入 API 密钥。");
      const current = await readCurrentSettings(ref);
      const catalog = await catalogService.load();
      const provider = findConnectableCatalogProvider(catalog, normalizedId);
      if (!provider) {
        throw new ProviderMutationError(
          404,
          "该供应商不支持直接使用单个 API Key 连接。",
        );
      }
      const existing = current.customProviders?.find(
        (item) => item.id === normalizedId,
      );
      if (existing && existing.source !== "models.dev") {
        throw new ProviderMutationError(
          409,
          `供应商 ID “${normalizedId}” 已被自定义供应商使用。`,
        );
      }
      const headers = resolveCatalogHeaders(input, existing?.headers);
      await validateProviderCredential({
        providerName: provider.id,
        providerDisplayName: provider.displayName,
        backendType: "openai_compat",
        apiKey: credential,
        baseUrl: provider.baseUrl,
        headers,
      });
      const settingsProvider: CustomProviderSettings = {
        id: provider.id,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        apiFormat: "openai",
        models: provider.models,
        source: "models.dev",
        ...(headers ? { headers } : {}),
      };
      const providers = (current.customProviders ?? []).filter(
        (item) => item.id !== normalizedId,
      );
      await saveCustomProviders([...providers, settingsProvider]);
      await storage.storeApiKey(provider.id, credential);
      return await rowForCustomProvider(
        settingsProvider,
        current.provider ?? "auto",
      );
    },
    async updateCatalogHeaders(id, headers) {
      const current = await readCurrentSettings(ref);
      const normalizedId = id.trim().toLowerCase();
      const index =
        current.customProviders?.findIndex(
          (item) => item.id === normalizedId,
        ) ?? -1;
      const existing = index >= 0 ? current.customProviders?.[index] : undefined;
      if (!existing || existing.source !== "models.dev") {
        throw new ProviderMutationError(
          404,
          `models.dev 目录供应商 “${normalizedId}” 不存在。`,
        );
      }
      const normalizedHeaders = normalizeProviderHeaders(headers);
      const nextProvider: CustomProviderSettings = {
        id: existing.id,
        displayName: existing.displayName,
        baseUrl: existing.baseUrl,
        apiFormat: existing.apiFormat,
        models: existing.models,
        source: "models.dev",
        ...(normalizedHeaders ? { headers: normalizedHeaders } : {}),
      };
      const nextProviders = [...(current.customProviders ?? [])];
      nextProviders[index] = nextProvider;
      await saveCustomProviders(nextProviders);
      return await rowForCustomProvider(
        nextProvider,
        current.provider ?? "auto",
      );
    },
    async disconnectCatalog(id) {
      const normalizedId = id.trim().toLowerCase();
      const current = await readCurrentSettings(ref);
      if (current.provider === normalizedId) {
        throw new ProviderMutationError(
          409,
          "该供应商正在使用中。请先切换到其他供应商，再断开连接。",
        );
      }
      const providers = current.customProviders ?? [];
      const existing = providers.find((item) => item.id === normalizedId);
      if (existing?.source !== "models.dev") {
        throw new ProviderMutationError(
          404,
          `models.dev 目录供应商 “${normalizedId}” 不存在。`,
        );
      }
      await saveCustomProviders(
        providers.filter((item) => item.id !== normalizedId),
      );
      await storage.clearProviderCredentials(normalizedId);
    },
  };
}

const UNSUPPORTED_BUILTIN_AUTH = new Set(["bedrock", "vertex"]);

function isSupportedBuiltinProvider(
  providerName: string,
  catalog: ModelsDevCatalog,
): boolean {
  if (providerName === "codex") return true;
  if (UNSUPPORTED_BUILTIN_AUTH.has(providerName)) return false;
  const spec = findByName(providerName);
  return !!spec?.envKey && !!readCatalogProvider(catalog, providerName);
}

function findConnectableCatalogProvider(
  catalog: ModelsDevCatalog,
  providerId: string,
): DirectApiKeyCatalogProvider | undefined {
  const provider = listDirectApiKeyCatalogProviders(catalog).find(
    (item) => item.id === providerId,
  );
  if (!provider || findByName(provider.id)) return undefined;
  const claimedByBuiltin = PROVIDERS.some(
    (spec) =>
      isSupportedBuiltinProvider(spec.name, catalog) &&
      readCatalogProvider(catalog, spec.name) === catalog[provider.catalogId],
  );
  return claimedByBuiltin ? undefined : provider;
}

export class ProviderMutationError extends ApplicationError {
  constructor(status: 400 | 404 | 409, message: string) {
    super(status, message);
  }
}

function resolveCatalogHeaders(
  input: ConnectCatalogProviderInput,
  existingHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, "headers")) {
    return existingHeaders;
  }
  return normalizeProviderHeaders(input.headers);
}

function normalizeProviderHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  try {
    if (
      headers !== undefined &&
      (headers === null ||
        typeof headers !== "object" ||
        Array.isArray(headers))
    ) {
      throw new RequestHeaderTemplateError(
        "Request headers must be a string record",
      );
    }
    const normalized = normalizeRequestHeaderTemplates(headers);
    if (!normalized || Object.keys(normalized).length === 0) {
      return undefined;
    }
    return normalized;
  } catch (error) {
    if (error instanceof RequestHeaderTemplateError) {
      throw new ProviderMutationError(400, error.message);
    }
    throw error;
  }
}

function normalizeCustomProvider(
  input: CustomProviderInput,
): CustomProviderSettings {
  const id = input.id?.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new ProviderMutationError(
      400,
      "供应商 ID 只能包含小写字母、数字、连字符或下划线。",
    );
  }
  const displayName = input.displayName?.trim();
  if (!displayName) throw new ProviderMutationError(400, "请输入显示名称。");
  const baseUrl = input.baseUrl?.trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error();
  } catch {
    throw new ProviderMutationError(
      400,
      "基础 URL 必须是有效的 HTTP 或 HTTPS 地址。",
    );
  }
  if (input.apiFormat !== "openai") {
    throw new ProviderMutationError(400, "当前仅支持 OpenAI 兼容接口。");
  }
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new ProviderMutationError(400, "请至少添加一个模型。");
  }
  const models = input.models.map((model) => ({
    id: model.id?.trim(),
    displayName: model.displayName?.trim() || model.id?.trim(),
    ...(model.imageInputSupport
      ? { imageInputSupport: model.imageInputSupport }
      : {}),
  }));
  if (models.some((model) => !model.id)) {
    throw new ProviderMutationError(400, "模型 ID 不能为空。");
  }
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new ProviderMutationError(400, "模型 ID 不能重复。");
  }
  const headers = normalizeProviderHeaders(input.headers);
  return {
    id,
    displayName,
    baseUrl,
    apiFormat: "openai",
    models,
    ...(headers ? { headers } : {}),
  };
}
