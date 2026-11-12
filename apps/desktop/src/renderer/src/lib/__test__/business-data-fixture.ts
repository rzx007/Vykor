import type {
  BusinessDataKey,
  BusinessDataRecord,
  DesktopBusinessDataApi,
} from "@shared/business-data-types"
const records = new Map<string, BusinessDataRecord>()
const sources = new Map<string, string>()
export let businessDataFixture: DesktopBusinessDataApi = {
  async recordDesktopScan() { return { id: "fixture-scan", ready: true } },
  async read(key) {
    return records.get(JSON.stringify(key)) ?? null
  },
  async write(key, value, revision) {
    const id = JSON.stringify(key),
      prior = records.get(id)
    if ((prior?.revision ?? null) !== revision) throw new Error("REVISION_CONFLICT")
    const record: BusinessDataRecord = {
      version: 1,
      revision: (prior?.revision ?? 0) + 1,
      value: structuredClone(value),
    }
    records.set(id, record)
    return record
  },
  async importLegacy(key, value, digest) {
    const id = JSON.stringify(key),
      prior = records.get(id)
    if (sources.has(id)) {
      if (sources.get(id) !== digest) throw new Error("LEGACY_CHANGED")
      return prior!
    }
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(value))
      throw new Error("LEGACY_CONFLICT")
    const record = prior ?? (await this.write(key, value, null))
    sources.set(id, digest)
    return record
  },
  async classifySessions(ids) {
    return Object.fromEntries(ids.map((id) => [id, "persistent" as const]))
  },
  async acknowledgeUnresolvedComposer() {},
  async flush() {},
  onFlushRequested() {
    return () => undefined
  },
}
export function businessDataSnapshot(key: BusinessDataKey): any {
  return records.get(JSON.stringify(key))?.value
}
export function resetBusinessDataFixture(): void {
  records.clear()
  sources.clear()
  businessDataFixture = { ...businessDataFixture }
}
