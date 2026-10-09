import type { AuthStatus, ModelProviderInfo, VykorClient, ProviderInfo } from "@vykor/client"

import type {
  ActivateDesktopProviderInput,
  ConnectDesktopProviderInput,
  DesktopProviderCredentialSource,
  DesktopProviderInfo,
  DesktopProviderSnapshot,
  DisconnectDesktopProviderInput,
  CreateDesktopCustomProviderInput,
  UpdateDesktopCatalogProviderHeadersInput,
  UpdateDesktopCustomProviderInput,
  RemoveDesktopCustomProviderInput,
} from "../../../shared/provider-types"
import { desktopSessionService } from "../session/session-service"
import { resolveDesktopRuntimeSnapshot } from "../session/runtime-selection"

type ProviderClient = Pick<VykorClient, "providers" | "auth" | "system">

export class DesktopProviderService {
  snapshot(): Promise<DesktopProviderSnapshot> {
    return withDaemonRetry(async (client) => {
      const [providers, auth, settings, models] = await Promise.all([
        client.providers.listProviders(),
        client.auth.getStatus(),
        client.system.getSettings(),
        client.providers.listModels().catch(() => []),
      ])
      return buildDesktopProviderSnapshot({ providers, auth, settings, models })
    })
  }

  async connect(input: ConnectDesktopProviderInput): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    const apiKey = input.apiKey.trim()
    if (!provider) throw new Error("请选择要连接的供应商。")
    if (!apiKey) throw new Error("请输入 API 密钥。")

    await withDaemonRetry(async (client) => {
      const catalogProvider = (await client.providers.listProviders()).find(
        (item) => item.name === provider && item.source === "catalog"
      )
      if (catalogProvider) {
        await client.providers.connectCatalogProvider(provider, {
          apiKey,
          ...("headers" in input ? { headers: input.headers } : {}),
          ...("secretHeaders" in input ? { secretHeaders: input.secretHeaders } : {}),
        })
      } else {
        await client.auth.login({ provider, apiKey })
      }
    })
    if (input.setActive) await this.activate({ provider })
    return await this.snapshot()
  }

  async activate(input: ActivateDesktopProviderInput): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    if (!provider) throw new Error("请选择要使用的供应商。")

    await withDaemonRetry(async (client) => {
      const requestedModel = input.model?.trim()
      await client.system.patchSettings({
        provider,
        ...(requestedModel ? { model: requestedModel } : {}),
      })
    })
    return await this.snapshot()
  }

  async disconnect(input: DisconnectDesktopProviderInput): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    if (!provider) throw new Error("请选择要断开的供应商。")

    await withDaemonRetry(async (client) => {
      const settings = await client.system.getSettings()
      const defaultChanged = await prepareDefaultRemoval(client, provider, settings, input)
      const catalogProvider = (await client.providers.listProviders()).find(
        (item) => item.name === provider && item.source === "catalog"
      )
      try {
        if (catalogProvider) await client.providers.disconnectCatalogProvider(provider)
        else await client.auth.logout({ provider })
      } catch (error) {
        await rollbackDefaultRemoval(client, settings, defaultChanged)
        throw error
      }
    })
    return await this.snapshot()
  }

  async updateCatalogHeaders(
    input: UpdateDesktopCatalogProviderHeadersInput
  ): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    if (!provider) throw new Error("请选择要更新的目录供应商。")

    await withDaemonRetry((client) =>
      input.secretHeaders === undefined
        ? client.providers.updateCatalogProviderHeaders(provider, input.headers)
        : client.providers.updateCatalogProviderHeaders(provider, input.headers, {
            secretHeaders: input.secretHeaders,
          })
    )
    return await this.snapshot()
  }

  async createCustom(input: CreateDesktopCustomProviderInput): Promise<DesktopProviderSnapshot> {
    await withDaemonRetry(async (client) => {
      await client.providers.createCustomProvider(input)
      if (input.setActive) {
        await client.system.patchSettings({ provider: input.id, model: input.models[0]?.id })
      }
    })
    return await this.snapshot()
  }

  async updateCustom(input: UpdateDesktopCustomProviderInput): Promise<DesktopProviderSnapshot> {
    await withDaemonRetry((client) =>
      client.providers.updateCustomProvider(input.provider, input.value)
    )
    return await this.snapshot()
  }

  async removeCustom(input: RemoveDesktopCustomProviderInput): Promise<DesktopProviderSnapshot> {
    await withDaemonRetry(async (client) => {
      const settings = await client.system.getSettings()
      const defaultChanged = await prepareDefaultRemoval(client, input.provider, settings, input)
      try {
        await client.providers.removeCustomProvider(input.provider)
      } catch (error) {
        await rollbackDefaultRemoval(client, settings, defaultChanged)
        throw error
      }
    })
    return await this.snapshot()
  }
}

export const desktopProviderService = new DesktopProviderService()

export function buildDesktopProviderSnapshot(input: {
  providers: ProviderInfo[]
  auth: AuthStatus
  settings: Record<string, unknown>
  models: ModelProviderInfo[]
}): DesktopProviderSnapshot {
  const flattenedModels = input.models.flatMap((provider) => provider.models)
  const runtimeSnapshot = resolveDesktopRuntimeSnapshot(flattenedModels, {
    model: input.settings.model,
    provider: input.settings.provider,
  })
  const activeProvider =
    input.settings.modelDisabled === true ? undefined : runtimeSnapshot.defaultProvider
  const activeModel =
    input.settings.modelDisabled === true ? undefined : runtimeSnapshot.defaultModel
  const stored = new Set(input.auth.storedProviders)
  const envByProvider = new Map(input.auth.envProviders.map((item) => [item.name, item.envKey]))
  const modelsByProvider = new Map(input.models.map((item) => [item.name, item.models]))
  const customByProvider = customProviderSettings(input.settings)

  const providers = input.providers.map((provider): DesktopProviderInfo => {
    const source = resolveCredentialSource(
      provider,
      input.auth,
      stored,
      envByProvider,
      customByProvider
    )
    const custom = customByProvider.get(provider.name)
    const models = (modelsByProvider.get(provider.name) ?? []).map((model) => {
      const declaredLimits = customByProvider
        .get(provider.name)
        ?.declaredLimitsByModel?.get(model.id)
      return {
        id: model.id,
        label: model.label,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.outputLimit ? { maxOutputTokens: model.outputLimit } : {}),
        ...(declaredLimits ? { declaredLimits } : {}),
        ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
        ...(model.inputCapabilities ? { imageInputSupport: model.inputCapabilities.image } : {}),
      }
    })
    return {
      name: provider.name,
      displayName: provider.displayName,
      connected: source !== "none",
      active: provider.name === activeProvider,
      local: provider.local === true,
      credentialSource: source,
      ...(credentialLabel(source, provider.name, input.auth, envByProvider)
        ? { credentialLabel: credentialLabel(source, provider.name, input.auth, envByProvider) }
        : {}),
      ...(provider.name === activeProvider && activeModel ? { currentModel: activeModel } : {}),
      models,
      ...(provider.custom ? { custom: true } : {}),
      ...(provider.source ? { source: provider.source } : {}),
      ...(custom?.baseUrl ? { baseUrl: custom.baseUrl } : {}),
      ...(custom?.apiFormat === "openai" ? { apiFormat: "openai" as const } : {}),
      ...(custom?.headers ? { headers: custom.headers } : {}),
      ...(custom?.secretHeaderNames ? { secretHeaderNames: custom.secretHeaderNames } : {}),
    }
  })

  return {
    providers,
    ...(activeProvider ? { activeProvider } : {}),
    ...(activeModel ? { activeModel } : {}),
  }
}

function resolveCredentialSource(
  provider: ProviderInfo,
  auth: AuthStatus,
  stored: Set<string>,
  envByProvider: Map<string, string>,
  customByProvider: Map<string, CustomProviderSettingView>
): DesktopProviderCredentialSource {
  if (provider.name === "codex") return auth.codex.configured ? "subscription" : "none"
  if (provider.source === "catalog") {
    return stored.has(provider.name) && customByProvider.get(provider.name)?.source === "models.dev"
      ? "credentials"
      : "none"
  }
  if (provider.custom) return stored.has(provider.name) ? "credentials" : "configured"
  if (provider.local) return "local"
  if (stored.has(provider.name)) return "credentials"
  if (envByProvider.has(provider.name)) return "environment"
  return "none"
}

interface CustomProviderSettingView {
  id: string
  baseUrl: string
  apiFormat: "openai"
  source?: string
  headers?: Record<string, string>
  secretHeaderNames?: string[]
  /** 用户在模型里自己填的上下文窗口/最大输出，按模型 id 索引。 */
  declaredLimitsByModel?: Map<string, { contextWindow?: number; maxOutputTokens?: number }>
}

function declaredLimitsByModel(
  value: unknown
): Map<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.flatMap(
    (item): Array<[string, { contextWindow?: number; maxOutputTokens?: number }]> => {
      if (!item || typeof item !== "object") return []
      const record = item as Record<string, unknown>
      if (typeof record.id !== "string" || !record.id) return []
      const contextWindow = positiveInteger(record.contextWindow)
      const maxOutputTokens = positiveInteger(record.maxOutputTokens)
      if (contextWindow === undefined && maxOutputTokens === undefined) return []
      return [
        [
          record.id,
          {
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          },
        ],
      ]
    }
  )
  return entries.length ? new Map(entries) : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function customProviderSettings(
  settings: Record<string, unknown>
): Map<string, CustomProviderSettingView> {
  const value = settings.customProviders
  if (!Array.isArray(value)) return new Map()
  const entries = value.flatMap((item): Array<[string, CustomProviderSettingView]> => {
    if (!item || typeof item !== "object") return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.baseUrl !== "string") return []
    const headers =
      record.headers && typeof record.headers === "object"
        ? Object.fromEntries(
            Object.entries(record.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined
    return [
      [
        record.id,
        {
          id: record.id,
          baseUrl: record.baseUrl,
          apiFormat: "openai",
          ...(typeof record.source === "string" ? { source: record.source } : {}),
          ...(headers ? { headers } : {}),
          ...(Array.isArray(record.secretHeaderNames)
            ? {
                secretHeaderNames: record.secretHeaderNames.filter(
                  (value): value is string => typeof value === "string"
                ),
              }
            : {}),
          ...(declaredLimitsByModel(record.models)
            ? { declaredLimitsByModel: declaredLimitsByModel(record.models) }
            : {}),
        },
      ],
    ]
  })
  return new Map(entries)
}

function credentialLabel(
  source: DesktopProviderCredentialSource,
  providerName: string,
  auth: AuthStatus,
  envByProvider: Map<string, string>
): string | undefined {
  if (source === "credentials") return "Vykor 密钥"
  if (source === "environment") return envByProvider.get(providerName)
  if (source === "subscription") return auth.codex.profileLabel ?? "Codex CLI"
  if (source === "local") return "本地服务"
  if (source === "configured") return "已配置"
  return undefined
}

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase()
}

async function prepareDefaultRemoval(
  client: ProviderClient,
  provider: string,
  settings: Record<string, unknown>,
  input: { replacement?: { provider: string; model: string }; disableDefault?: boolean }
) {
  if (settings.modelDisabled === true) return false
  const modelProviders = await client.providers.listModels()
  if (
    settings.provider !== provider &&
    resolveDesktopRuntimeSnapshot(
      modelProviders.flatMap((item) => item.models),
      settings
    ).defaultProvider !== provider
  )
    return false
  if (input.replacement) {
    if (input.replacement.provider === provider) throw new Error("替代默认模型必须来自其他供应商。")
    const models = modelProviders.flatMap((item) => item.models)
    if (
      !models.some(
        (item) =>
          item.providerName === input.replacement!.provider && item.id === input.replacement!.model
      )
    )
      throw new Error("替代默认模型不可用，请重新选择。")
    await client.system.patchSettings({ ...input.replacement, effort: "", modelDisabled: false })
  } else if (input.disableDefault === true) {
    await client.system.patchSettings({ modelDisabled: true })
  } else
    throw new Error("这是当前默认连接。请明确选择替代默认模型，或确认关闭新任务默认模型后再移除。")
  return true
}

async function rollbackDefaultRemoval(
  client: ProviderClient,
  settings: Record<string, unknown>,
  changed: boolean
) {
  if (!changed) return
  try {
    await client.system.patchSettings({
      provider: settings.provider ?? "auto",
      model: settings.model,
      effort: settings.effort ?? "",
      modelDisabled: settings.modelDisabled === true,
    })
  } catch {
    throw new Error("连接移除失败，默认模型回退也失败。请重新读取供应商与默认模型状态后重试。")
  }
}

async function withDaemonRetry<T>(operation: (client: ProviderClient) => Promise<T>): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}
