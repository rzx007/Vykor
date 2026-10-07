import type { MemoryEntryRecord, MemoryRevision } from "@vykor/client"
export interface PersonalizationMemoryPreferences {
  enabled: boolean
  autoExtractEnabled: boolean
  sessionMemoryEnabled: boolean
  autoDreamEnabled: boolean
  autoDreamMinHours: number
  autoDreamMinSessions: number
}
export interface PersonalizationManagementSnapshot {
  effective: PersonalizationMemoryPreferences
  configured:
    | (Partial<PersonalizationMemoryPreferences> & {
        maxFiles?: number
        maxEntrypointLines?: number
      })
    | null
  sources: Record<string, string>
  rules: string[]
  consolidation: {
    lastConsolidatedAt: number | null
    status: string
    taskId?: string
    finishedAt?: number
    error?: string
  }
  projectId?: string
  projectPath?: string
  directory?: string
  entries: MemoryEntryRecord[]
  managementAvailable: boolean
}
export interface PersonalizationManagementAPI {
  snapshot(input?: { projectId?: string }): Promise<PersonalizationManagementSnapshot>
  updateConfiguration(input: {
    projectId?: string
    value: PersonalizationMemoryPreferences | null
    expected: PersonalizationManagementSnapshot["configured"]
  }): Promise<PersonalizationManagementSnapshot>
  updateEntry(input: {
    projectId: string
    id: string
    content: string
    expectedRevision: string
  }): Promise<PersonalizationManagementSnapshot>
  removeEntry(input: {
    projectId: string
    id: string
    expectedRevision: string
  }): Promise<PersonalizationManagementSnapshot>
  clearEntries(input: {
    projectId: string
    expectedEntries: MemoryRevision[]
  }): Promise<PersonalizationManagementSnapshot>
  openRule(input: { projectId: string; path: string }): Promise<void>
  openDirectory(input: { projectId: string }): Promise<void>
}
export const PersonalizationManagementChannels = {
  snapshot: "personalization-management:snapshot",
  updateConfiguration: "personalization-management:update-configuration",
  updateEntry: "personalization-management:update-entry",
  removeEntry: "personalization-management:remove-entry",
  clearEntries: "personalization-management:clear-entries",
  openRule: "personalization-management:open-rule",
  openDirectory: "personalization-management:open-directory",
} as const
export type PersonalizationManagementIpcMap = {
  [
    K in keyof typeof PersonalizationManagementChannels as (typeof PersonalizationManagementChannels)[K]
  ]: {
    args: Parameters<PersonalizationManagementAPI[K]>
    result: Awaited<ReturnType<PersonalizationManagementAPI[K]>>
  }
}
