import type {
  BusinessDataKey,
  BusinessDataRecord,
  DesktopBusinessDataApi,
} from "@shared/business-data-types"
import { businessSchemas } from "@shared/business-data-schema"

const clients = new WeakMap<DesktopBusinessDataApi, Map<string, RecoveryRecord>>()
const pendingTasks = new Set<Promise<unknown>>()
const taskFailures = new Map<string, unknown>()
const flushers = new Set<() => Promise<void>>()
export function registerBusinessDataFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush)
  return () => {
    flushers.delete(flush)
  }
}
export async function flushRendererBusinessData(): Promise<void> {
  while (pendingTasks.size) await Promise.all([...pendingTasks])
  await Promise.all([...flushers].map((flush) => flush()))
  for (const record of clients.get(window.desktop.businessData)?.values() ?? [])
    await record.flush()
  while (pendingTasks.size) await Promise.all([...pendingTasks])
  if (taskFailures.size) throw taskFailures.values().next().value
  await window.desktop.businessData.flush()
}
export function recoveryRecord(key: BusinessDataKey): RecoveryRecord {
  const api = window.desktop.businessData
  let records = clients.get(api)
  if (!records) {
    records = new Map()
    clients.set(api, records)
  }
  const id = JSON.stringify(key)
  let record = records.get(id)
  if (!record) {
    record = new RecoveryRecord(api, key)
    records.set(id, record)
  }
  return record
}
export async function legacyDigest(raw: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
// This client only addresses the four schema-checked business kinds, never paths.
class RecoveryRecord {
  private loaded?: Promise<BusinessDataRecord | null>
  private record: BusinessDataRecord | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private failure: unknown
  private importedRaw?: string
  private importing?: { raw: string; promise: Promise<void> }
  constructor(
    private readonly api: DesktopBusinessDataApi,
    readonly key: BusinessDataKey
  ) {}
  async read(): Promise<BusinessDataRecord | null> {
    this.loaded ??= this.api
      .read(this.key)
      .then((record) => {
        this.record = record
        return record
      })
      .catch((error) => {
        this.loaded = undefined
        throw error
      })
    await this.loaded
    await this.tail
    return this.record
  }
  importLegacy(raw: string, value: unknown, unresolvedSessionIds: string[] = []): Promise<void> {
    if (this.importedRaw === raw) return Promise.resolve()
    if (this.importing?.raw === raw) return this.importing.promise
    const promise = this.performImport(raw, value, unresolvedSessionIds)
      .then(() => {
        this.importedRaw = raw
      })
      .finally(() => {
        this.importing = undefined
      })
    this.importing = { raw, promise }
    return promise
  }
  private async performImport(
    raw: string,
    value: unknown,
    unresolvedSessionIds: string[]
  ): Promise<void> {
    await this.read()
    const parsed = businessSchemas[this.key.kind].safeParse(value)
    if (!parsed.success) throw new Error(`business-data ${this.key.kind} import INVALID_VALUE`)
    this.record = await this.api.importLegacy(
      this.key,
      parsed.data,
      await legacyDigest(raw),
      unresolvedSessionIds
    )
  }
  write(value: unknown): Promise<void> {
    const snapshot = structuredClone(value)
    return this.update(() => snapshot)
  }
  update(update: (value: unknown) => unknown): Promise<void> {
    // Read before enqueueing to avoid awaiting our own write tail.
    const ready = (this.loaded ??= this.api
      .read(this.key)
      .then((record) => {
        this.record = record
        return record
      })
      .catch((error) => {
        this.loaded = undefined
        throw error
      }))
    const next = this.tail.then(async () => {
      await ready
      this.record = await this.api.write(
        this.key,
        update(this.record?.value),
        this.record?.revision ?? null
      )
      this.failure = undefined
    })
    this.tail = next.catch((error) => {
      this.failure = error
    })
    return next
  }
  async flush(): Promise<void> {
    await this.loaded
    await this.importing?.promise
    await this.tail
    if (this.failure) throw this.failure
  }
}

export function trackBusinessDataTask<T>(scope: string, task: Promise<T>): Promise<T> {
  pendingTasks.add(task)
  void task
    .then(
      () => {
        taskFailures.delete(scope)
      },
      (error) => {
        taskFailures.set(scope, error)
      }
    )
    .finally(() => {
      pendingTasks.delete(task)
    })
  return task
}
/** Export only explicitly owned legacy keys; UI preferences and unrelated keys stay in the browser. */
export async function importOtherLegacyBusinessData(
  storage: Storage = localStorage
): Promise<void> {
  const keys: Array<[string, BusinessDataKey]> = [
    ["vykor.desktop.note-recovery-v1", { kind: "notes" }],
    ["vykor.desktop.note-recovery-v1:quick", { kind: "quick-notes" }],
  ]
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key && /^vykor-image-annotations-v1:[a-f0-9]{64}$/.test(key))
      keys.push([
        key,
        { kind: "image-annotations", imageKey: key.slice("vykor-image-annotations-v1:".length) },
      ])
  }
  for (const [source, key] of keys) {
    const raw = storage.getItem(source)
    if (!raw) continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error(`business-data ${key.kind} import INVALID_JSON`)
    }
    await recoveryRecord(key).importLegacy(raw, value)
  }
}

/** Called after the backend confirms a root switch, with the old writers already flushed. */
export function resetBusinessDataCache(): void {
  if (typeof window !== "undefined" && window.desktop?.businessData)
    clients.delete(window.desktop.businessData)
  taskFailures.clear()
}
