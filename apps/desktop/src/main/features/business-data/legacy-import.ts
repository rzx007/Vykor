import { createHash, randomUUID } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { requireCompleteAbsolutePath } from "@vykor/host-config/paths"
const confirmation = z.object({
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  status: z.enum(["confirmed", "partial"]).default("confirmed"),
  unresolvedSessionIds: z.array(z.string().min(1).max(256)).max(10000).default([]),
  reason: z.literal("session-not-found").optional(),
  retainedSourceAcknowledged: z.boolean().optional(),
})
const scanSources = z.record(z.string().regex(/^(composer|notes|quick-notes|image-annotations:[a-f0-9]{64})$/), z.string().regex(/^[a-f0-9]{64}$/))
const legacySources = z.object({
  version: z.literal(1), status: z.enum(["pending", "consumed"]), sourceRoot: z.string(), sourceIdentity: z.string(), userDataDir: z.string(), documentsDir: z.string(),
  environment: z.object({ VYKOR_DATA_DIR: z.string().optional(), VYKOR_CHANNELS_DIR: z.string().optional(), VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: z.string().optional() }).strict(),
  identities: z.array(z.object({ path: z.string(), identity: z.string() })).max(4), databasePath: z.string().optional(),
})
const desktopScan = z.object({
  version: z.literal(1), id: z.string().min(1), userDataDir: z.string().min(1), documentsDir: z.string().min(1), sources: scanSources,
})
const schema = z.object({ version: z.literal(1), sources: z.record(z.string(), confirmation), desktopScan: desktopScan.optional(), legacySources: legacySources.optional() })
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
  if (source !== "git-settings" && manifest.desktopScan && manifest.desktopScan.sources[source] !== record.sourceDigest) delete manifest.desktopScan
  writeManifest(path, manifest)
}

function writeManifest(path: string, manifest: z.infer<typeof schema>): void {
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

export function invalidateDesktopScan(path: string): void {
  const manifest = readLegacyImportManifest(path)
  if (!manifest.desktopScan) return
  delete manifest.desktopScan
  writeManifest(path, manifest)
}

/** Called only with app.getPath locations by the host; the renderer supplies digests, never paths. */
export function recordDesktopScan(path: string, sources: Record<string, string>, host: { userDataDir: string; documentsDir: string; legacySources?: z.infer<typeof legacySources> }): { id: string; ready: boolean } {
  const parsed = scanSources.safeParse(sources)
  if (!parsed.success) { invalidateDesktopScan(path); throw new Error("business-data desktop-scan INVALID_SCAN") }
  const manifest = readLegacyImportManifest(path)
  for (const [id, digest] of Object.entries(parsed.data)) {
    if (manifest.sources[id]?.sourceDigest !== digest) {
      invalidateDesktopScan(path)
      throw new Error("business-data desktop-scan UNCONFIRMED_SOURCE")
    }
  }
  const scan = { version: 1 as const, id: randomUUID(),
    userDataDir: requireCompleteAbsolutePath(host.userDataDir, "userDataDir"),
    documentsDir: requireCompleteAbsolutePath(host.documentsDir, "documentsDir"), sources: parsed.data }
  if (host.legacySources) manifest.legacySources = legacySources.parse(host.legacySources)
  manifest.desktopScan = scan
  writeManifest(path, manifest)
  return { id: scan.id, ready: Object.keys(scan.sources).every(id => manifest.sources[id]!.status === "confirmed" || manifest.sources[id]!.retainedSourceAcknowledged === true) }
}

export function acknowledgeUnresolvedComposer(path: string, sourceDigest: string): void {
  const record = readLegacyImportManifest(path).sources.composer
  if (!record || record.status !== "partial" || record.sourceDigest !== sourceDigest)
    throw new Error("business-data composer acknowledge INVALID_PARTIAL_SOURCE")
  confirmLegacyImport(path, "composer", { ...record, retainedSourceAcknowledged: true })
}
