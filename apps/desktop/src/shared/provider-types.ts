export type DesktopProviderCredentialSource =
  "credentials" | "environment" | "subscription" | "local" | "configured" | "none"

export type DesktopInputSupport = "native" | "unsupported" | "unknown"

export interface DesktopProviderModel {
  id: string
  label: string
  imageInputSupport?: DesktopInputSupport
  contextWindow?: number
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
