import type {
  AuthStatus,
  ModelProviderInfo,
  VykorClient,
  ProviderInfo,
} from "@vykor/client"

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
      if (settings.provider === provider) {
        await client.system.patchSettings({ provider: "auto" })
      }
      const catalogProvider = (await client.providers.listProviders()).find(
        (item) => item.name === provider && item.source === "catalog"
      )
      if (catalogProvider) await client.providers.disconnectCatalogProvider(provider)
      else await client.auth.logout({ provider })
    })
    return await this.snapshot()
  }

  async updateCatalogHeaders(
    input: UpdateDesktopCatalogProviderHeadersInput
  ): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    if (!provider) throw new Error("请选择要更新的目录供应商。")

    await withDaemonRetry((client) =>
      client.providers.updateCatalogProviderHeaders(provider, input.headers)
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
    await withDaemonRetry((client) => client.providers.updateCustomProvider(input.provider, input.value))
    return await this.snapshot()
  }

  async removeCustom(input: RemoveDesktopCustomProviderInput): Promise<DesktopProviderSnapshot> {
    await withDaemonRetry(async (client) => {
      const settings = await client.system.getSettings()
      if (settings.provider === input.provider) {
        await client.system.patchSettings({ provider: "auto" })
      }
      await client.providers.removeCustomProvider(input.provider)
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
  const activeProvider = runtimeSnapshot.defaultProvider
  const activeModel = runtimeSnapshot.defaultModel
  const stored = new Set(input.auth.storedProviders)
  const envByProvider = new Map(input.auth.envProviders.map((item) => [item.name, item.envKey]))
  const modelsByProvider = new Map(input.models.map((item) => [item.name, item.models]))
  const customByProvider = customProviderSettings(input.settings)

  const providers = input.providers.map((provider): DesktopProviderInfo => {
    const source = resolveCredentialSource(provider, input.auth, stored, envByProvider, customByProvider)
    const custom = customByProvider.get(provider.name)
    const models = (modelsByProvider.get(provider.name) ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.inputCapabilities
        ? { imageInputSupport: model.inputCapabilities.image }
        : {}),
    }))
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
    return stored.has(provider.name) &&
      customByProvider.get(provider.name)?.source === "models.dev"
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

async function withDaemonRetry<T>(
  operation: (client: ProviderClient) => Promise<T>
): Promise<T> {
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
