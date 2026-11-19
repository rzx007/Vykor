import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { listDataRootWriters, resolveManagedRealPath, withDataRootLock } from "@vykor/host-config/paths"
import {
  acquireRegistryLease,
  daemonPidAlive,
  readDaemonRegistry,
  readLegacyDataLocation,
  readRegisteredDataLocation,
  requestDaemon,
  sameDaemonRegistration,
  stopRegisteredDaemon,
  withDaemonControlLock,
  type DaemonRegistry,
} from "@vykor/server/daemon-host"
import { hasDesktopNotesImportReceipt, importLegacyNotes } from "@vykor/services/notes"
import { isLoopbackDaemonUrl } from "../daemon-autostart/daemon-surface"

interface LegacyNoteImportOptions {
  dataRoot: string
  dataDirectory: string
  homeDirectory: string
  legacyDataLocationPath: string
  destination: string
  flushRecovery?: () => Promise<void>
  onDaemonStopped?: () => Promise<void>
}

export async function prepareLegacyNoteImport(options: LegacyNoteImportOptions): Promise<void> {
  if (relative(await resolveManagedRealPath(options.destination), options.destination))
    throw new Error("本地便签目录指向其他位置。请核对数据目录。")
  if (hasDesktopNotesImportReceipt(options.destination)) return
  await withDataRootLock(options.homeDirectory, async (lock) => {
    lock.assertWritableRoot(options.dataRoot)
    if (hasDesktopNotesImportReceipt(options.destination)) return

    const { dataDirectory } = options
    const databasePath = join(dataDirectory, "session-runtime", "sessions.db")
    const registryPath = join(dataDirectory, "daemon", "registry.json")
    if (relative(await resolveManagedRealPath(dirname(databasePath)), dirname(databasePath)))
      throw new Error("旧便签数据库目录指向其他位置。请核对数据目录。")
    const [registered, oldDesktop] = await Promise.all([
      readRegisteredDataLocation(dataDirectory),
      readLegacyDataLocation(options.legacyDataLocationPath),
    ])
    const selected = registered ?? oldDesktop
    if (selected && (relative(dataDirectory, selected.directory) || relative(databasePath, selected.storePath)))
      throw new Error("旧便签位于另一数据目录。请先完成数据根迁移。")

    if (oldDesktop && relative(dataDirectory, oldDesktop.directory)) {
      const alternate = await readRegistry(join(oldDesktop.directory, "daemon", "registry.json"))
      if (alternate && daemonPidAlive(alternate.pid))
        throw new Error("另一个数据目录的后台仍在运行。请确认便签所在的数据目录后重试。")
    }

    if (relative(await resolveManagedRealPath(dirname(registryPath)), dirname(registryPath)))
      throw new Error("无法确认旧便签后台登记目录。")
    await withDaemonControlLock(async (controlSignal) => {
      const registry = await readRegistry(registryPath)
      const running = registry && daemonPidAlive(registry.pid) ? registry : undefined
      await assertOtherWritersStopped(options.dataRoot, running?.pid)
      if (running) {
        if (relative(databasePath, running.storePath))
          throw new Error("运行中的后台使用另一份数据库。请确认便签来源后重试。")
        await options.flushRecovery?.()
        await stopLegacyDaemon(registryPath, running, controlSignal)
        await options.onDaemonStopped?.()
      }

      const owner = new AbortController()
      const release = await acquireRegistryLease(registryPath, "owner", (error) => owner.abort(error))
      try {
        const signal = AbortSignal.any([controlSignal, owner.signal])
        const latest = await readRegistry(registryPath)
        if (latest && daemonPidAlive(latest.pid)) throw new Error("后台已重新启动。请稍后重试便签导入。")
        await assertOtherWritersStopped(options.dataRoot)
        signal.throwIfAborted()
        await importLegacyNotes({ databasePath, destination: options.destination }, { signal })
      } finally {
        if (!owner.signal.aborted) await release()
      }
    }, registryPath)
  }, { timeoutMs: 15000 })
}

async function assertOtherWritersStopped(root: string, daemonPid?: number): Promise<void> {
  const busy = (await listDataRootWriters(root)).some((writer) =>
    !(writer.kind === "desktop" && writer.pid === process.pid) &&
    !(writer.kind === "daemon" && writer.pid === daemonPid),
  )
  if (busy) throw new Error("仍有其他进程正在写入旧便签的数据目录。请正常关闭后重试。")
}

async function readRegistry(path: string): Promise<DaemonRegistry | undefined> {
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink() || relative(await realpath(path), path))
      throw new Error("无法核对旧便签后台登记文件。")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const registry = readDaemonRegistry(path)
  if (!registry || !Number.isSafeInteger(registry.pid) || registry.pid <= 0 ||
    !Number.isSafeInteger(registry.startedAt) || typeof registry.url !== "string" ||
    typeof registry.token !== "string" || !registry.token || typeof registry.storePath !== "string" ||
    !isAbsolute(registry.storePath) || typeof registry.version !== "string")
    throw new Error("无法核对旧便签后台登记内容。")
  return registry
}

async function stopLegacyDaemon(path: string, expected: DaemonRegistry, signal: AbortSignal): Promise<void> {
  const url = new URL(expected.url)
  if (expected.pid === process.pid || !isLoopbackDaemonUrl(expected.url) ||
    url.protocol !== "http:" || url.username || url.password)
    throw new Error("无法验证旧便签后台的本机进程。")

  const verify = async (registry: DaemonRegistry) => {
    if (!sameDaemonRegistration(registry, expected)) return false
    const response = await requestDaemon(registry, "/debug/process", {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    return response.ok && (await response.json()).pid === expected.pid
  }
  if (!await verify(expected) || !sameDaemonRegistration(await readRegistry(path), expected))
    throw new Error("无法验证旧便签后台的本机进程。")

  const drained = await requestDaemon(expected, "/maintenance/prepare-root-migration", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
  })
  if (!drained.ok || (await drained.json()).prepared !== true)
    throw new Error("旧便签后台仍有未结束的工作。请收尾后重试便签导入。")
  signal.throwIfAborted()
  const latest = await readRegistry(path)
  if (latest && !sameDaemonRegistration(latest, expected))
    throw new Error("旧便签后台在收尾后发生变化。请稍后重试。")
  if (daemonPidAlive(expected.pid) && !latest)
    throw new Error("旧便签后台登记在收尾后消失。请稍后重试。")
  if (latest) await stopRegisteredDaemon(verify, path)
}
