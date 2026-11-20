import type { DesktopCustomProviderInput, DesktopInputSupport } from "@shared/provider-types"
import {
  headersFromRows,
  type RequestHeaderError,
  type RequestHeaderRow,
} from "./request-header-form"

export interface CustomProviderModelRow {
  key: string
  id: string
  displayName: string
  imageInputSupport: DesktopInputSupport
  /** 以字符串保存，空串表示"交给服务端按模型 id 自动匹配"。 */
  contextWindow: string
  maxOutputTokens: string
}

export type CustomProviderHeaderRow = RequestHeaderRow

export interface CustomProviderFormState {
  id: string
  displayName: string
  baseUrl: string
  apiKey: string
  models: CustomProviderModelRow[]
  headers: CustomProviderHeaderRow[]
  secretHeaderNames?: string[]
}

export type CustomProviderFormValidation =
  | { ok: true; value: DesktopCustomProviderInput }
  | {
      ok: false
      field: "id" | "displayName" | "baseUrl" | "models" | "headers"
      message: string
      rowKey?: string
      modelField?: "id" | "contextWindow" | "maxOutputTokens"
      headerError?: RequestHeaderError
    }

type ModelLimitParse = { kind: "blank" } | { kind: "ok"; value: number } | { kind: "invalid" }

/** 留空表示自动匹配；填了就必须是大于 0 的整数。 */
function parseModelLimit(raw: string): ModelLimitParse {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: "blank" }
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? { kind: "ok", value } : { kind: "invalid" }
}

export function validateCustomProviderForm(
  form: CustomProviderFormState
): CustomProviderFormValidation {
  const displayName = form.displayName.trim()
  if (!displayName) return { ok: false, field: "displayName", message: "请输入显示名称。" }
  const id = form.id.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return {
      ok: false,
      field: "id",
      message: "供应商 ID 只能包含小写字母、数字、连字符或下划线。",
    }
  }
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
    contextWindow: parseModelLimit(model.contextWindow),
    maxOutputTokens: parseModelLimit(model.maxOutputTokens),
  }))
  const emptyModel = models.findIndex((model) => !model.id)
  if (emptyModel !== -1) {
    return {
      ok: false,
      field: "models",
      rowKey: form.models[emptyModel].key,
      modelField: "id",
      message: "模型 ID 不能为空。",
    }
  }
  const ids = new Set<string>()
  for (const [index, model] of models.entries()) {
    if (ids.has(model.id)) {
      return {
        ok: false,
        field: "models",
        rowKey: form.models[index].key,
        modelField: "id",
        message: "模型 ID 不能重复。",
      }
    }
    ids.add(model.id)
  }
  const invalidLimits = models.findIndex(
    (model) => model.contextWindow.kind === "invalid" || model.maxOutputTokens.kind === "invalid"
  )
  if (invalidLimits !== -1) {
    return {
      ok: false,
      field: "models",
      rowKey: form.models[invalidLimits].key,
      modelField:
        models[invalidLimits].contextWindow.kind === "invalid"
          ? "contextWindow"
          : "maxOutputTokens",
      message: "上下文窗口和最大输出要填大于 0 的整数，留空表示自动匹配。",
    }
  }
  const headersResult = headersFromRows(form.headers, form.secretHeaderNames)
  if (!headersResult.ok) {
    return {
      ok: false,
      field: "headers",
      message: headersResult.message,
      headerError: headersResult,
    }
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
      models: models.map(({ contextWindow, maxOutputTokens, ...model }) => ({
        ...model,
        ...(contextWindow.kind === "ok" ? { contextWindow: contextWindow.value } : {}),
        ...(maxOutputTokens.kind === "ok" ? { maxOutputTokens: maxOutputTokens.value } : {}),
      })),
      ...(Object.keys(headersResult.headers).length > 0 ? { headers: headersResult.headers } : {}),
      ...(headersResult.secretHeaders ? { secretHeaders: headersResult.secretHeaders } : {}),
    },
  }
}
