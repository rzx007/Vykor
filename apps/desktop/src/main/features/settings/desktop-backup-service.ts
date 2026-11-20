import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { isCompleteAbsolutePath } from "@vykor/host-config/paths"
import type { MaintenanceBackupResult } from "../../../shared/maintenance-settings-types"

const manifestFile = "desktop-backup.json"

interface BackupOptions { destination: string; includeMemory: boolean; includeOutput: boolean }
interface DesktopBackupManifest {
  version: 1
  daemon: { id: string; checksumsSha256: string }
  notes: Record<string, string>
}
interface Dependencies {
  liveRoot(): string
  createDaemon(input: BackupOptions & { recordAudit: false }): Promise<MaintenanceBackupResult>
  verifyDaemon(source: string): Promise<MaintenanceBackupResult>
  restoreDaemon(source: string, target: string): Promise<MaintenanceBackupResult>
  flushDesktop(): Promise<void>
  backupNotes(destination: string): Promise<void>
  validateNotes(directory: string): void | Promise<void>
  importNotes(input: { databasePath: string; notesDirectory: string; destination: string }): Promise<unknown>
  recordBackup(result: MaintenanceBackupResult): Promise<void>
}

export class DesktopBackupService {
  constructor(private readonly deps: Dependencies) {}

  async backup(input: BackupOptions): Promise<MaintenanceBackupResult> {
    const liveRoot = await realpath(this.deps.liveRoot())
    const result = await publishToEmptyDirectory(input.destination, [liveRoot], async (stage, destination) => {
      await this.deps.flushDesktop()
      const notes = join(stage, "notes")
      await this.deps.backupNotes(notes)
      const daemon = join(stage, "daemon")
      const created = await this.deps.createDaemon({ ...input, destination: daemon, recordAudit: false })
      const verified = await this.deps.verifyDaemon(daemon)
      if (created.manifest.backupId !== verified.manifest.backupId) throw new Error("后台备份标识校验失败。")
      if (verified.manifest.version !== 4 || verified.manifest.scope !== "daemon-only") {
        throw new Error("请先更新并重启后台，再创建桌面备份。")
      }
      await this.deps.validateNotes(notes)
      const snapshot = await hashNoteSnapshot(notes)
      const manifest: DesktopBackupManifest = {
        version: 1,
        daemon: { id: verified.manifest.backupId, checksumsSha256: await sha256(join(daemon, "checksums.json")) },
        notes: snapshot.files,
      }
      await writeFile(join(stage, manifestFile), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      return combinedResult({ ...created, ...verified }, destination, snapshot.bytes)
    })
    try {
      await this.deps.recordBackup(result)
      return result
    } catch {
      return { ...result, historyRecorded: false }
    }
  }

  async verify(source: string): Promise<MaintenanceBackupResult> {
    return (await this.verifySource(await existingDirectory(source))).result
  }

  async restore(input: { source: string; target: string }): Promise<MaintenanceBackupResult> {
    const source = await existingDirectory(input.source)
    const liveRoot = await realpath(this.deps.liveRoot())
    if (!relative(liveRoot, source)) throw new Error("备份、恢复目标与活动数据根必须完全分离。")
    const verified = await this.verifySource(source)
    return publishToEmptyDirectory(input.target, [source, liveRoot], async (stage, target) => {
      const data = join(stage, "data")
      await mkdir(data)
      const runtime = join(data, "session-runtime")
      const restored = await this.deps.restoreDaemon(verified.daemon, runtime)
      if (restored.manifest.backupId !== verified.result.manifest.backupId) throw new Error("后台恢复标识校验失败。")
      for (const directory of ["memory", "session-memory", "tasks"]) {
        const recovered = join(runtime, directory)
        if (await statIfPresent(recovered)) await rename(recovered, join(data, directory))
      }
      const destination = join(data, "desktop", "notes")
      if (verified.notes) {
        await mkdir(dirname(destination), { recursive: true })
        await cp(verified.notes, destination, { recursive: true, errorOnExist: true, force: false })
        const copied = await hashNoteSnapshot(destination)
        if (!isDeepStrictEqual(copied.files, verified.noteFiles)) throw new Error("便签备份在恢复期间发生变化，校验失败。")
        await this.deps.validateNotes(destination)
      } else if (restored.manifest.version < 4) {
        await this.deps.importNotes({ databasePath: join(runtime, "sessions.db"), notesDirectory: join(runtime, "notes"), destination })
      }
      if (verified.daemonChecksums && await sha256(join(verified.daemon, "checksums.json")) !== verified.daemonChecksums) {
        throw new Error("后台备份在恢复期间发生变化，校验失败。")
      }
      const settingsPath = restored.settingsSnapshotPath
      if (settingsPath && !contains(stage, settingsPath)) throw new Error("后台恢复返回了无效的设置快照路径。")
      return {
        ...restored,
        path: target,
        desktopNotes: Boolean(verified.notes) || restored.manifest.version < 4,
        ...(settingsPath ? { settingsSnapshotPath: join(target, relative(stage, settingsPath)) } : {}),
      }
    })
  }

  private async verifySource(source: string) {
    const metadata = await statIfPresent(join(source, manifestFile))
    if (!metadata) return { daemon: source, result: await this.deps.verifyDaemon(source) }
    if (!metadata.isFile()) throw new Error("桌面备份清单必须是普通文件。")
    const manifest: DesktopBackupManifest = JSON.parse(await readFile(join(source, manifestFile), "utf8"))
    if (manifest?.version !== 1 || typeof manifest.daemon?.id !== "string" || typeof manifest.daemon.checksumsSha256 !== "string") {
      throw new Error("桌面备份清单版本或内容无效。")
    }
    const daemon = join(source, "daemon")
    const notes = join(source, "notes")
    if (!(await lstat(daemon)).isDirectory()) throw new Error("后台备份必须是原始子目录。")
    const snapshot = await hashNoteSnapshot(notes)
    if (!isDeepStrictEqual(snapshot.files, manifest.notes) || await sha256(join(daemon, "checksums.json")) !== manifest.daemon.checksumsSha256) {
      throw new Error("桌面备份文件校验失败。")
    }
    await this.deps.validateNotes(notes)
    const result = await this.deps.verifyDaemon(daemon)
    if (result.manifest.backupId !== manifest.daemon.id) throw new Error("后台备份标识校验失败。")
    return { daemon, daemonChecksums: manifest.daemon.checksumsSha256, notes, noteFiles: snapshot.files, result: combinedResult(result, source, snapshot.bytes) }
  }
}

function combinedResult(daemon: MaintenanceBackupResult, path: string, noteBytes: number): MaintenanceBackupResult {
  return {
    ...daemon, path, desktopNotes: true,
    ...(daemon.excludes ? { excludes: daemon.excludes.filter((item) => item !== "桌面便签") } : {}),
    ...(daemon.totalBytes === undefined ? {} : { totalBytes: daemon.totalBytes + noteBytes }),
  }
}

async function sha256(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error("备份清单只接受普通文件。")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function hashNoteSnapshot(directory: string) {
  if (!(await lstat(directory)).isDirectory()) throw new Error("便签备份必须是原始子目录。")
  const entries: Array<[string, string]> = []
  let bytes = 0
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    entries.push([name, await sha256(path)])
    bytes += (await lstat(path)).size
  }
  return { files: Object.fromEntries(entries), bytes }
}

async function statIfPresent(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

function assertSeparate(first: string, second: string): void {
  if (contains(first, second) || contains(second, first)) throw new Error("备份、恢复目标与活动数据根必须完全分离。")
}

async function existingDirectory(path: string): Promise<string> {
  if (!isCompleteAbsolutePath(path)) throw new Error("请选择完整的备份目录路径。")
  if (!(await lstat(path)).isDirectory()) throw new Error("备份路径必须是目录。")
  return realpath(path)
}

async function publishToEmptyDirectory<T>(
  requested: string,
  protectedDirectories: string[],
  work: (stage: string, destination: string) => Promise<T>,
): Promise<T> {
  if (!isCompleteAbsolutePath(requested)) throw new Error("请选择完整的目标目录路径。")
  const target = await statIfPresent(requested)
  if (target && !target.isDirectory()) throw new Error("请选择一个空目录。")
  const canonical = target ? await realpath(requested) : join(await realpath(dirname(requested)), relative(dirname(requested), requested))
  for (const protectedDirectory of protectedDirectories) assertSeparate(canonical, protectedDirectory)
  if (target && (await readdir(canonical)).length > 0) throw new Error("只允许写入空目录。")
  const stage = await mkdtemp(join(dirname(canonical), ".vykor-desktop-backup-"))
  let removedEmptyDirectory = false
  let published = false
  try {
    const result = await work(stage, canonical)
    const current = await statIfPresent(canonical)
    if (target && !current) throw new Error("目标目录在操作期间发生变化。")
    if (current) {
      if (!target || current.dev !== target.dev || current.ino !== target.ino) throw new Error("目标目录在操作期间发生变化。")
      await rmdir(canonical)
      removedEmptyDirectory = true
    }
    await rename(stage, canonical)
    published = true
    return result
  } finally {
    if (!published) {
      if (removedEmptyDirectory) await mkdir(canonical, { recursive: true })
      await rm(stage, { recursive: true, force: true })
    }
  }
}
