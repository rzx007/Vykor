import { resolve } from "node:path"
import type { DesktopModel, DesktopPermissionMode, SendDesktopPromptInput, SessionUserInputItem } from "@shared/session-types"
import type { SessionOperationsClient } from "./session-operations"

export function resolveRequiredPath(value: unknown): string {
  return resolve(requireString(value, "项目路径"))
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

export function normalizePermissionMode(value: unknown): DesktopPermissionMode | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined
}

export function requirePermissionMode(value: unknown): DesktopPermissionMode {
  const mode = normalizePermissionMode(value)
  if (!mode) throw new Error("权限模式必须是 default、plan 或 full_auto。")
  return mode
}

export function optionalProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const provider = value.trim()
  if (!provider || provider.toLowerCase() === "configured") return undefined
  return provider
}

export async function resolveProviderForModel(
  client: SessionOperationsClient,
  model: string,
  requestedProvider: unknown
): Promise<string | undefined> {
  const provider = optionalProvider(requestedProvider)
  const models = (await client.providers.listModels()).flatMap((item) => item.models)
  if (provider) {
    if (!models.some((item) => item.id === model && item.providerName === provider)) {
      throw new Error(`模型 ${model} 不属于 provider ${provider}。`)
    }
    return provider
  }

  const providers = uniqueModelProviders(models, model)
  if (providers.length <= 1) return providers[0]
  throw new Error(`模型 ${model} 在多个 provider 中同名，请明确指定 provider。`)
}

function uniqueModelProviders(models: DesktopModel[], model: string): string[] {
  return [
    ...new Set(
      models
        .filter((item) => item.id === model)
        .map((item) => optionalProvider(item.providerName))
        .filter((item): item is string => Boolean(item))
    ),
  ]
}

export function normalizePromptAttachments(
  value: unknown,
  autoOnly: boolean
): SendDesktopPromptInput["attachments"] {
  if (!Array.isArray(value)) throw new Error("附件必须是数组。")
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") {
      throw new Error(`第 ${index + 1} 个附件无效。`)
    }
    const record = attachment as Record<string, unknown>
    const intent = requireAttachmentIntent(record.intent, index)
    if (autoOnly && intent !== "auto") {
      throw new Error(`第 ${index + 1} 个附件 intent 必须是 auto。`)
    }
    return {
      assetId: requireString(record.assetId, `第 ${index + 1} 个附件 assetId`),
      intent,
      displayName: requireString(record.displayName, `第 ${index + 1} 个附件名称`),
    }
  })
}

export function requirePromptItems(value: unknown): SessionUserInputItem[] {
  if (!Array.isArray(value)) throw new Error("消息 items 必须是数组。")
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 个消息 item 无效。`)
    }
    const record = item as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", text: record.text }
    }
    if (
      record.type === "context" &&
      record.kind === "conversation" &&
      typeof record.id === "string" &&
      typeof record.displayName === "string"
    ) {
      return {
        type: "context",
        kind: "conversation",
        id: record.id,
        displayName: record.displayName,
      }
    }
    if (
      record.type === "mention" &&
      typeof record.name === "string" &&
      typeof record.path === "string"
    ) {
      return {
        type: "mention",
        name: record.name,
        path: record.path,
        ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
      }
    }
    if (
      record.type === "capability" &&
      (record.kind === "plugin" || record.kind === "plugin_agent") &&
      typeof record.pluginId === "string" &&
      typeof record.displayName === "string"
    ) {
      if (record.kind === "plugin_agent") {
        if (typeof record.agentId !== "string") {
          throw new Error(`第 ${index + 1} 个消息 item 的 agentId 无效。`)
        }
        return {
          type: "capability",
          kind: "plugin_agent",
          pluginId: record.pluginId,
          agentId: record.agentId,
          displayName: record.displayName,
        }
      }
      return {
        type: "capability",
        kind: "plugin",
        pluginId: record.pluginId,
        displayName: record.displayName,
      }
    }
    if (
      record.type === "skill" &&
      typeof record.name === "string" &&
      typeof record.path === "string"
    ) {
      const source = record.source
      if (
        source !== undefined &&
        source !== "bundled" &&
        source !== "user" &&
        source !== "project" &&
        source !== "plugin"
      ) {
        throw new Error(`第 ${index + 1} 个消息 item 的 source 无效。`)
      }
      return {
        type: "skill",
        name: record.name,
        path: record.path,
        ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
        ...(source ? { source } : {}),
      }
    }
    throw new Error(`第 ${index + 1} 个消息 item 无效。`)
  })
}

export function hasPromptItems(items: readonly SessionUserInputItem[]): boolean {
  return items.some((item) => item.type !== "text" || item.text.trim().length > 0)
}

function requireAttachmentIntent(
  value: unknown,
  index: number
): SendDesktopPromptInput["attachments"][number]["intent"] {
  if (
    value === "auto" ||
    value === "vision" ||
    value === "ocr" ||
    value === "document" ||
    value === "tool_resource" ||
    value === "workspace_reference"
  ) {
    return value
  }
  throw new Error(`第 ${index + 1} 个附件 intent 无效。`)
}
