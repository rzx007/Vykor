export interface RuntimeEnvironmentConfig {
  kind: "native" | "wsl"
  distribution?: string
  shell?: { executable: string; args: string[] }
  env?: Record<string, string>
  secretEnv?: string[]
}
export interface RuntimeSettingsSnapshot {
  userConfig: RuntimeEnvironmentConfig
  projectConfig: RuntimeEnvironmentConfig | null
  activeDefault: RuntimeEnvironmentConfig
  effective: RuntimeEnvironmentConfig
  source: string
  restartRequired: boolean
  wslSupported: boolean
  inheritedVariableNames: string[]
  distributions: string[]
  secretRevision: string
}
export const RuntimeSettingsChannels = { snapshot: "runtime-settings:snapshot", save: "runtime-settings:save", check: "runtime-settings:check", restart: "runtime-settings:restart" } as const
export interface RuntimeSettingsAPI {
  snapshot(input?: { cwd?: string }): Promise<RuntimeSettingsSnapshot>
  save(input: { cwd?: string; config: RuntimeEnvironmentConfig | null; expected: RuntimeEnvironmentConfig | null; secrets?: Record<string, string | null>; expectedSecretRevision?: string }): Promise<RuntimeSettingsSnapshot>
  check(input: { cwd: string; config: RuntimeEnvironmentConfig }): Promise<Array<{ name: string; status: "ok" | "warning" | "failed"; detail: string }>>
  restart(input?: { stopActive?: boolean }): Promise<RuntimeSettingsSnapshot>
}
export type RuntimeSettingsIpcMap = {
  [K in keyof typeof RuntimeSettingsChannels as (typeof RuntimeSettingsChannels)[K]]: {
    args: Parameters<RuntimeSettingsAPI[K]>; result: Awaited<ReturnType<RuntimeSettingsAPI[K]>>
  }
}
