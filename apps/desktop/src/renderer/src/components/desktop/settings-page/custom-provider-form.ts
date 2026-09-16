import type { DesktopCustomProviderInput, DesktopInputSupport } from "@shared/provider-types"
import { headersFromRows, type RequestHeaderRow } from "./request-header-form"

export interface CustomProviderModelRow {
  key: string
  id: string
  displayName: string
  imageInputSupport: DesktopInputSupport
}

export type CustomProviderHeaderRow = RequestHeaderRow

export interface CustomProviderFormState {
  id: string
  displayName: string
  baseUrl: string
  apiKey: string
  models: CustomProviderModelRow[]
  headers: CustomProviderHeaderRow[]
}

export type CustomProviderFormValidation =
  | { ok: true; value: DesktopCustomProviderInput }
  | { ok: false; field: "id" | "displayName" | "baseUrl" | "models" | "headers"; message: string }

export function validateCustomProviderForm(
  form: CustomProviderFormState
): CustomProviderFormValidation {
  const id = form.id.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return {
      ok: false,
      field: "id",
      message: "供应商 ID 只能包含小写字母、数字、连字符或下划线。",
    }
  }
  const displayName = form.displayName.trim()
  if (!displayName) return { ok: false, field: "displayName", message: "请输入显示名称。" }
  const baseUrl = form.baseUrl.trim()
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error()
  } catch {
    return {
      ok: false,
      field: "baseUrl",
      message: "基础 URL 必须是有效的 HTTP 或 HTTPS 地址。",
    }
  }
  if (form.models.length === 0) {
    return { ok: false, field: "models", message: "请至少添加一个模型。" }
  }
  const models = form.models.map((model) => ({
    id: model.id.trim(),
    displayName: model.displayName.trim() || model.id.trim(),
    imageInputSupport: model.imageInputSupport,
  }))
  if (models.some((model) => !model.id)) {
    return { ok: false, field: "models", message: "模型 ID 不能为空。" }
  }
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    return { ok: false, field: "models", message: "模型 ID 不能重复。" }
  }
  const headersResult = headersFromRows(form.headers)
  if (!headersResult.ok) {
    return { ok: false, field: "headers", message: headersResult.message }
  }
  const apiKey = form.apiKey.trim()
  return {
    ok: true,
    value: {
      id,
      displayName,
      baseUrl,
      apiFormat: "openai",
      ...(apiKey ? { apiKey } : {}),
      models,
      ...(Object.keys(headersResult.headers).length > 0 ? { headers: headersResult.headers } : {}),
    },
  }
}
