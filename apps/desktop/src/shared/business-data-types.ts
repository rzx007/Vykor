export type BusinessDataKey =
  { kind: "composer" | "notes" | "quick-notes" } | { kind: "image-annotations"; imageKey: string }
export interface BusinessDataRecord {
  version: 1
  revision: number
  value: unknown
}
export interface BusinessDataApi {
  read(key: BusinessDataKey): Promise<BusinessDataRecord | null>
  write(
    key: BusinessDataKey,
    value: unknown,
    expectedRevision: number | null
  ): Promise<BusinessDataRecord>
  flush(): Promise<void>
}
export interface DesktopBusinessDataApi extends BusinessDataApi {
  recordDesktopScan(sources: Record<string, string>): Promise<{ id: string; ready: boolean }>
  importLegacy(
    key: BusinessDataKey,
    value: unknown,
    sourceDigest: string,
    unresolvedSessionIds?: string[]
  ): Promise<BusinessDataRecord>
  acknowledgeUnresolvedComposer(sourceDigest: string): Promise<void>
  classifySessions(ids: string[]): Promise<Record<string, "persistent" | "memory" | "unknown">>
  onFlushRequested(listener: (freeze?: boolean) => Promise<void>, onExportResumed?: () => void): () => void
}
export const BusinessDataChannels = {
  recordDesktopScan: "business-data:record-desktop-scan",
  read: "business-data:read",
  write: "business-data:write",
  flush: "business-data:flush",
  importLegacy: "business-data:import-legacy",
  classifySessions: "business-data:classify-sessions",
  acknowledgeUnresolved: "business-data:acknowledge-unresolved-composer",
  flushAck: "business-data:flush-ack",
  consumerReady: "business-data:consumer-ready",
} as const
export interface BusinessDataIpcMap {
  [BusinessDataChannels.recordDesktopScan]: { args: [Record<string, string>]; result: { id: string; ready: boolean } }
  [BusinessDataChannels.consumerReady]: { args: []; result: void }
  [BusinessDataChannels.acknowledgeUnresolved]: { args: [string]; result: void }
  [BusinessDataChannels.read]: { args: [BusinessDataKey]; result: BusinessDataRecord | null }
  [BusinessDataChannels.write]: {
    args: [BusinessDataKey, unknown, number | null]
    result: BusinessDataRecord
  }
  [BusinessDataChannels.flush]: { args: []; result: void }
  [BusinessDataChannels.importLegacy]: {
    args: [BusinessDataKey, unknown, string, string[]?]
    result: BusinessDataRecord
  }
  [BusinessDataChannels.classifySessions]: {
    args: [string[]]
    result: Record<string, "persistent" | "memory" | "unknown">
  }
  [BusinessDataChannels.flushAck]: { args: [string, boolean]; result: void }
}
