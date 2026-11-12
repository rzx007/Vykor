import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { getDataRoot, resolveUserDataPaths } from "@vykor/host-config/paths"
import { businessDataKeySchema, businessSchemas } from "../../../shared/business-data-schema"
import type { BusinessDataKey, BusinessDataRecord } from "../../../shared/business-data-types"
import {
  acknowledgeUnresolvedComposer,
  confirmLegacyImport,
  digestBusinessValue,
  readLegacyImportManifest,
  invalidateDesktopScan,
  recordDesktopScan,
} from "./legacy-import"
export class BusinessDataService {
  // ponytail: one queue for desktop recovery volume; split by record only if throughput requires it.
  private tail: Promise<unknown> = Promise.resolve()
  private failures = new Map<string, Error>()
  constructor(private readonly root?: string) {}
  private paths() {
    return resolveUserDataPaths(this.root ?? getDataRoot())
  }
  private location(input: BusinessDataKey) {
    const parsed = businessDataKeySchema.safeParse(input)
    if (!parsed.success) throw new Error("business-data validate INVALID_KEY")
    const key = parsed.data,
      paths = this.paths()
    const path =
      key.kind === "image-annotations"
        ? join(paths.imageAnnotationsDir, `${key.imageKey}.json`)
        : {
            composer: paths.composerRecoveryFilePath,
            notes: paths.notesRecoveryFilePath,
            "quick-notes": paths.quickNotesRecoveryFilePath,
          }[key.kind]
    return {
      key,
      path,
      id: key.kind === "image-annotations" ? `${key.kind}:${key.imageKey}` : key.kind,
    }
  }
  private value(key: BusinessDataKey, value: unknown): unknown {
    const parsed = businessSchemas[key.kind].safeParse(value)
    if (!parsed.success) throw new Error(`business-data ${key.kind} validate INVALID_VALUE`)
    return parsed.data
  }
  private async load(key: BusinessDataKey, path: string): Promise<BusinessDataRecord | null> {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as BusinessDataRecord
      if (record?.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1)
        throw new Error("INVALID_RECORD")
      return { version: 1, revision: record.revision, value: this.value(key, record.value) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new Error(`business-data ${key.kind} read INVALID_RECORD ${path}`)
    }
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action)
    this.tail = next.catch(() => undefined)
    return next
  }
  read(input: BusinessDataKey): Promise<BusinessDataRecord | null> {
    return this.enqueue(async () => {
      const { key, path } = this.location(input)
      return this.load(key, path)
    })
  }
  write(
    input: BusinessDataKey,
    value: unknown,
    expectedRevision: number | null
  ): Promise<BusinessDataRecord> {
    return this.enqueue(async () => {
      const { key, path, id } = this.location(input)
      try {
        const parsed = this.value(key, value),
          current = await this.load(key, path)
        if (expectedRevision !== (current?.revision ?? null)) throw new Error("REVISION_CONFLICT")
        if (current && digestBusinessValue(current.value) === digestBusinessValue(parsed)) {
          this.failures.delete(id)
          return current
        }
        const record: BusinessDataRecord = {
          version: 1,
          revision: (current?.revision ?? 0) + 1,
          value: parsed,
        }
        await this.replace(path, record)
        this.failures.delete(id)
        return record
      } catch (error) {
        const code =
          error instanceof Error && /REVISION_CONFLICT|INVALID_VALUE/.test(error.message)
            ? error.message.includes("REVISION_CONFLICT")
              ? "REVISION_CONFLICT"
              : "INVALID_VALUE"
            : "WRITE_FAILED"
        const failure = new Error(`business-data ${key.kind} write ${code} ${path}`)
        this.failures.set(id, failure)
        throw failure
      }
    })
  }
  importLegacy(
    input: BusinessDataKey,
    value: unknown,
    sourceDigest: string,
    unresolvedSessionIds: string[] = []
  ): Promise<BusinessDataRecord> {
    return this.enqueue(async () => {
      const { key, path, id } = this.location(input),
        parsed = this.value(key, value)
      if (!/^[a-f0-9]{64}$/.test(sourceDigest))
        throw new Error("business-data import INVALID_DIGEST")
      if (
        !Array.isArray(unresolvedSessionIds) ||
        unresolvedSessionIds.length > 10000 ||
        unresolvedSessionIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
        (key.kind !== "composer" && unresolvedSessionIds.length)
      )
        throw new Error("business-data import INVALID_UNRESOLVED_IDS")
      const manifestPath = this.paths().legacyImportFilePath,
        manifest = readLegacyImportManifest(manifestPath), prior = manifest.sources[id]
      if (manifest.desktopScan && manifest.desktopScan.sources[id] !== sourceDigest) invalidateDesktopScan(manifestPath)
      let current = await this.load(key, path)
      if (prior) {
        if (prior.sourceDigest !== sourceDigest) {
          invalidateDesktopScan(manifestPath)
          throw new Error(`business-data ${key.kind} import LEGACY_CHANGED`)
        }
        if (!current) throw new Error(`business-data ${key.kind} import TARGET_MISSING`)
        return current
      }
      const targetDigest = digestBusinessValue(parsed)
      if (current && digestBusinessValue(current.value) !== targetDigest)
        throw new Error(`business-data ${key.kind} import LEGACY_CONFLICT`)
      if (!current) {
        current = { version: 1, revision: 1, value: parsed }
        await this.replace(path, current)
      }
      const verified = await this.load(key, path)
      if (!verified || digestBusinessValue(verified.value) !== targetDigest)
        throw new Error(`business-data ${key.kind} import VERIFY_FAILED`)
      confirmLegacyImport(manifestPath, id, {
        sourceDigest,
        targetDigest,
        revision: verified.revision,
        status: unresolvedSessionIds.length ? "partial" : "confirmed",
        unresolvedSessionIds,
        ...(unresolvedSessionIds.length ? { reason: "session-not-found" as const } : {}),
      })
      return verified
    })
  }
  acknowledgeUnresolvedComposer(digest: string): Promise<void> {
    return this.enqueue(async () =>
      acknowledgeUnresolvedComposer(this.paths().legacyImportFilePath, digest)
    )
  }
  recordDesktopScan(sources: Record<string, string>, host: { userDataDir: string; documentsDir: string }): Promise<{ id: string; ready: boolean }> {
    return this.enqueue(async () => {
      if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
        invalidateDesktopScan(this.paths().legacyImportFilePath)
        throw new Error("business-data desktop-scan INVALID_SCAN")
      }
      const manifest = readLegacyImportManifest(this.paths().legacyImportFilePath)
      for (const id of Object.keys(sources)) {
        // Validate IPC input first; do not treat a missing target as a successful export.
        if (!/^(composer|notes|quick-notes|image-annotations:[a-f0-9]{64})$/.test(id)) continue
        const input: BusinessDataKey = id.startsWith("image-annotations:")
          ? { kind: "image-annotations", imageKey: id.slice("image-annotations:".length) }
          : { kind: id as "composer" | "notes" | "quick-notes" }
        const { key, path } = this.location(input)
        if (manifest.sources[id]) {
          let valid = false
          try { valid = !!await this.load(key, path) } catch { /* Invalid records are not exported. */ }
          if (!valid) {
            invalidateDesktopScan(this.paths().legacyImportFilePath)
            throw new Error("business-data desktop-scan TARGET_MISSING")
          }
        }
      }
      return recordDesktopScan(this.paths().legacyImportFilePath, sources, host)
    })
  }
  async flush(): Promise<void> {
    await this.tail
    const failure = this.failures.values().next().value
    if (failure) throw failure
  }
  private async replace(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value), "utf8")
      await rename(temporary, path)
    } catch {
      throw new Error(`business-data replace WRITE_FAILED ${path}`)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
export const desktopBusinessDataService = new BusinessDataService()
