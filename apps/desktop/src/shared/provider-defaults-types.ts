import type { ModelInfo } from "@vykor/client"

export interface ProviderDefaultsSnapshot {
  models: ModelInfo[]
  provider: string | null
  model: string | null
  effort: string | null
  disabled: boolean
  revision: string
  verified: Record<string, { model: string; checkedAt: number }>
  fastModeAvailable: false
  fastModeReason: string
}
export interface UpdateProviderDefaultEffortInput { effort: string | null; expectedRevision: string }
export interface ProviderConnectionTestResult { status: "verified" | "failed"; category?: "authentication" | "address" | "network" | "model" | "unsupported" | "service"; detail: string; checkedAt: number }
export const ProviderDefaultsChannels = { snapshot: "provider-defaults:snapshot", updateEffort: "provider-defaults:update-effort", test: "provider-defaults:test" } as const
export interface ProviderDefaultsAPI {
  snapshot(): Promise<ProviderDefaultsSnapshot>
  updateEffort(input: UpdateProviderDefaultEffortInput): Promise<ProviderDefaultsSnapshot>
  test(input: { provider: string; model: string }): Promise<ProviderConnectionTestResult>
}
export type ProviderDefaultsIpcMap = {
  [K in keyof typeof ProviderDefaultsChannels as (typeof ProviderDefaultsChannels)[K]]: { args: Parameters<ProviderDefaultsAPI[K]>; result: Awaited<ReturnType<ProviderDefaultsAPI[K]>> }
}
