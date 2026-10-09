export type DesktopProviderCredentialSource =
  "credentials" | "environment" | "subscription" | "local" | "configured" | "none"

export type DesktopInputSupport = "native" | "unsupported" | "unknown"

export interface DesktopProviderModel {
  id: string
  label: string
  imageInputSupport?: DesktopInputSupport
  /** 最终生效的上下文窗口（用户填的或按模型 id 匹配到的）。 */
  contextWindow?: number
  /** 最终生效的最大输出（用户填的或按模型 id 匹配到的）。 */
  maxOutputTokens?: number
  /** 用户在自定义供应商里亲自填的值，仅用于回填编辑表单；留空表示交给自动匹配。 */
  declaredLimits?: { contextWindow?: number; maxOutputTokens?: number }
  reasoningEfforts?: string[]
}

export interface DesktopProviderInfo {
  name: string
  displayName: string
  connected: boolean
  active: boolean
  local: boolean
  credentialSource: DesktopProviderCredentialSource
  credentialLabel?: string
  currentModel?: string
  models: DesktopProviderModel[]
  custom?: boolean
  source?: "builtin" | "catalog" | "custom" | "subscription"
  baseUrl?: string
  apiFormat?: "openai"
  headers?: Record<string, string>
  secretHeaderNames?: string[]
}

export interface DesktopProviderSnapshot {
  providers: DesktopProviderInfo[]
  activeProvider?: string
  activeModel?: string
}

export interface ConnectDesktopProviderInput {
  provider: string
  apiKey: string
  headers?: Record<string, string>
  secretHeaders?: Record<string, string | null>
  setActive?: boolean
}

export interface UpdateDesktopCatalogProviderHeadersInput {
  provider: string
  headers: Record<string, string>
  secretHeaders?: Record<string, string | null>
}

export interface ActivateDesktopProviderInput {
  provider: string
  model?: string
}

export interface DisconnectDesktopProviderInput {
  provider: string
  replacement?: { provider: string; model: string }
  disableDefault?: boolean
}

export interface DesktopCustomProviderInput {
  id: string
  displayName: string
  baseUrl: string
  apiFormat: "openai"
  apiKey?: string
  models: Array<{
    id: string
    displayName: string
    imageInputSupport?: DesktopInputSupport
    /** 留空则由服务端按模型 id 到模型目录匹配。 */
    contextWindow?: number
    maxOutputTokens?: number
  }>
  headers?: Record<string, string>
  secretHeaders?: Record<string, string | null>
}

export interface CreateDesktopCustomProviderInput extends DesktopCustomProviderInput {
  setActive?: boolean
}

export interface UpdateDesktopCustomProviderInput {
  provider: string
  value: DesktopCustomProviderInput
}

export interface RemoveDesktopCustomProviderInput {
  provider: string
  replacement?: { provider: string; model: string }
  disableDefault?: boolean
}
