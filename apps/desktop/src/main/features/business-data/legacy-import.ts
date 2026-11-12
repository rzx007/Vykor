import { createHash, randomUUID } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
const confirmation = z.object({
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  status: z.enum(["confirmed", "partial"]).default("confirmed"),
  unresolvedSessionIds: z.array(z.string().min(1).max(256)).max(10000).default([]),
  reason: z.literal("session-not-found").optional(),
  retainedSourceAcknowledged: z.boolean().optional(),
})
const schema = z.object({ version: z.literal(1), sources: z.record(z.string(), confirmation) })
export type LegacyImportConfirmation = z.input<typeof confirmation>
export function digestBusinessValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function readLegacyImportManifest(path: string): z.infer<typeof schema> {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sources: {} }
    throw new Error(`business-data legacy-import read INVALID_MANIFEST ${path}`)
  }
}
export function confirmLegacyImport(
  path: string,
  source: string,
  record: LegacyImportConfirmation
): void {
  const manifest = readLegacyImportManifest(path)
  manifest.sources[source] = confirmation.parse(record)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(manifest), "utf8")
    renameSync(temporary, path)
  } catch {
    throw new Error(`business-data legacy-import confirm WRITE_FAILED ${path}`)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function acknowledgeUnresolvedComposer(path: string, sourceDigest: string): void {
  const record = readLegacyImportManifest(path).sources.composer
  if (!record || record.status !== "partial" || record.sourceDigest !== sourceDigest)
    throw new Error("business-data composer acknowledge INVALID_PARTIAL_SOURCE")
  confirmLegacyImport(path, "composer", { ...record, retainedSourceAcknowledged: true })
}
