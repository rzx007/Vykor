import type { DesktopModel, DesktopPermissionMode } from "@shared/session-types"
import { permissionModeOptions } from "../composer/controls"

export function resolveModelLabel(
  models: DesktopModel[],
  modelId: string | null,
  providerName: string | null
): string {
  if (!modelId) return "选择模型"
  return (
    models.find((model) => model.id === modelId && model.providerName === providerName)?.label ??
    models.find((model) => model.id === modelId)?.label ??
    modelId
  )
}

export function resolvePermissionModeLabel(mode: DesktopPermissionMode): string {
  return permissionModeOptions.find((option) => option.value === mode)?.label ?? mode
}
export function appendDraftText(current: string, text: string): string {
  const trimmedText = text.trim()
  if (!trimmedText) return current
  if (!current.trim()) return trimmedText
  if (current.endsWith(" ") || current.endsWith("\n")) return `${current}${trimmedText}`
  return `${current} ${trimmedText}`
}
