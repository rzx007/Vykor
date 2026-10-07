export interface SettingsImportPreview { id: string; name: string; groups: Array<{ id: string; label: string; changes: Array<{ key: string; before: string; after: string }> }> }
export const ConfigurationSettingsChannels = { review: "configuration-settings:review", updateReview: "configuration-settings:update-review", exportFile: "configuration-settings:export", previewImport: "configuration-settings:preview-import", applyImport: "configuration-settings:apply-import" } as const
export interface ConfigurationSettingsAPI {
  review(): Promise<{ mode: "off" | "risk_based" }>
  updateReview(input: { mode: "off" | "risk_based"; expected: "off" | "risk_based" }): Promise<{ mode: "off" | "risk_based" }>
  exportFile(categories: string[]): Promise<string | null>
  previewImport(): Promise<SettingsImportPreview | null>
  applyImport(input: { id: string; categories: string[] }): Promise<void>
}
export type ConfigurationSettingsIpcMap = { [K in keyof typeof ConfigurationSettingsChannels as typeof ConfigurationSettingsChannels[K]]: { args: Parameters<ConfigurationSettingsAPI[K]>; result: Awaited<ReturnType<ConfigurationSettingsAPI[K]>> } }
