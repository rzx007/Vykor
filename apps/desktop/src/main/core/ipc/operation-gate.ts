import { AsyncLocalStorage } from "node:async_hooks"
import { BusinessDataChannels } from "../../../shared/business-data-types"
import type { DataRootWriterLease } from "@vykor/host-config/paths"

/** Covers whole IPC operations, including Git children that can refresh indexes. */
export class DesktopOperationGate {
  private phase: "open" | "draining" | "sealed" = "open"
  private readonly context = new AsyncLocalStorage<symbol>()
  private readonly active = new Map<symbol, Promise<void>>()
  async run<T>(channel: string, action: () => T | Promise<T>): Promise<T> {
    if (this.phase !== "open" && !(this.phase === "draining" && Object.values(BusinessDataChannels).includes(channel as never)))
      throw new Error("数据根迁移期间已暂停桌面操作，请等待重启。")
    const id = Symbol(channel)
    let finish!: () => void
    this.active.set(id, new Promise(resolve => { finish = resolve }))
    try { return await this.context.run(id, action) }
    finally { this.active.delete(id); finish() }
  }
  async freeze(): Promise<void> { this.phase = "draining"; await this.drain() }
  async seal(): Promise<void> { this.phase = "sealed"; await this.drain() }
  /** Only the host may call after failed export and verified recovery of the unchanged source. */
  resumeAfterFailedExport(): void {
    if (this.phase !== "draining") throw new Error("已封门的桌面必须重新启动。")
    this.phase = "open"
  }
  private async drain(): Promise<void> {
    const own = this.context.getStore()
    while ([...this.active.keys()].some(id => id !== own))
      await Promise.all([...this.active].filter(([id]) => id !== own).map(([, done]) => done))
  }
}
export const desktopOperationGate = new DesktopOperationGate()
let rootWriter: DataRootWriterLease | undefined
export function setDesktopRootWriter(writer: DataRootWriterLease): void { rootWriter = writer }
export async function releaseDesktopRootWriter(): Promise<void> {
  if (!rootWriter) throw new Error("桌面尚未登记数据根写入资格。")
  await rootWriter.release()
}
