import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type {
  VykorClient,
  MarketplaceSelection,
  MarketplacePreview,
  MarketplaceOperation,
} from "@vykor/application-client"
import type { WebContents } from "electron"
import type { DesktopMarketplacePreview } from "../../../shared/plugin-types"

type Selection = {
  senderId: number
  cwd: string
  expires: number
  preview: MarketplacePreview
  operationId: string
  timer: ReturnType<typeof setTimeout>
}
/** Main owns candidate permissions and operation IDs; renderer only receives an opaque handle. */
export class MarketplaceService {
  private selections = new Map<string, Selection>()
  private windows = new Set<number>()
  private operations = new Map<string, { senderId: number; cwd: string }>()
  constructor(
    private client: () => Promise<VykorClient>,
    private now = Date.now,
    private queryClient = client,
  ) {}

  async preview(
    sender: WebContents,
    input: MarketplaceSelection,
  ): Promise<DesktopMarketplacePreview> {
    const cwd = resolve(input.cwd)
    for (const [id, selection] of this.selections)
      if (selection.senderId === sender.id) await this.release(id)
    const preview = await (
      await this.client()
    ).plugins.marketplacePreview({
      cwd,
      sourceId: input.sourceId,
      pluginId: input.pluginId,
      version: input.version,
    })
    if (sender.isDestroyed()) {
      await (await this.client()).plugins.marketplaceCancel({ candidateId: preview.candidateId })
      throw new Error("窗口已关闭。")
    }
    if (!this.windows.has(sender.id)) {
      this.windows.add(sender.id)
      sender.once("destroyed", () => {
        this.windows.delete(sender.id)
        for (const [id, selection] of this.selections)
          if (selection.senderId === sender.id) void this.release(id)
        for (const [id, owner] of this.operations)
          if (owner.senderId === sender.id) this.operations.delete(id)
      })
    }
    const selectionId = randomUUID()
    const timer = setTimeout(() => {
      void this.release(selectionId)
    }, 600_000)
    timer.unref?.()
    this.selections.set(selectionId, {
      senderId: sender.id,
      cwd,
      expires: this.now() + 600_000,
      preview,
      operationId: randomUUID(),
      timer,
    })
    const result: DesktopMarketplacePreview = {
      selectionId,
      pluginName: preview.identity.displayName ?? preview.identity.name,
      requestedPermissions: [...preview.requestedPermissions],
      replacementRequired: preview.replacementRequired,
      sourceName: preview.sourceName,
      approvalRequired: preview.approvalRequired || preview.replacementRequired,
    }
    if (!result.approvalRequired)
      result.operation = await this.confirm(sender, { cwd, selectionId })
    return result
  }

  async confirm(
    sender: WebContents,
    input: { cwd: string; selectionId: string },
  ): Promise<MarketplaceOperation> {
    const selection = this.selections.get(input.selectionId)
    if (
      !selection ||
      selection.senderId !== sender.id ||
      selection.cwd !== resolve(input.cwd) ||
      selection.expires <= this.now()
    )
      throw new Error("安装确认已失效，请重新选择插件。")
    this.selections.delete(input.selectionId)
    clearTimeout(selection.timer)
    if (this.operations.size >= 128) this.operations.delete(this.operations.keys().next().value!)
    this.operations.set(selection.operationId, { senderId: sender.id, cwd: selection.cwd })
    let operation: MarketplaceOperation
    try {
      operation = await (
        await this.client()
      ).plugins.marketplaceInstall({
        cwd: selection.cwd,
        candidateId: selection.preview.candidateId,
        operationId: selection.operationId,
        approvedPermissions:
          selection.preview.approvalRequired || selection.preview.replacementRequired
            ? [...selection.preview.requestedPermissions]
            : [],
        ...(selection.preview.replacementRequired ? { allowSourceChange: true } : {}),
      })
    } catch (error) {
      const body = error && typeof error === "object" && "body" in error ? error.body : undefined
      const code =
        body && typeof body === "object" && "code" in body && typeof body.code === "string"
          ? body.code
          : undefined
      const message =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : error instanceof Error
            ? error.message
            : String(error)
      if (code || !/Failed to fetch|ECONNREFUSED|ECONNRESET|fetch failed/u.test(message))
        return {
          operationId: selection.operationId,
          status: "failed",
          message,
          ...(code ? { code } : {}),
        }
      // The server may already have committed. Never replay the mutation.
      operation = await this.query(sender, {
        cwd: selection.cwd,
        operationId: selection.operationId,
      }).catch(() => ({
        operationId: selection.operationId,
        status: "unknown" as const,
        message: "安装结果暂时无法确认，请检查安装结果。",
      }))
    }
    for (
      let attempt = 0;
      attempt < 3 && (operation.status === "pending" || operation.status === "unknown");
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      operation = await this.query(sender, {
        cwd: selection.cwd,
        operationId: selection.operationId,
      }).catch(() => operation)
    }
    return operation
  }

  async query(
    sender: WebContents,
    input: { cwd: string; operationId: string },
  ): Promise<MarketplaceOperation> {
    const owner = this.operations.get(input.operationId)
    if (!owner || owner.senderId !== sender.id || owner.cwd !== resolve(input.cwd))
      throw new Error("找不到当前窗口的安装记录。")
    return (await this.queryClient()).plugins.marketplaceOperation(input.operationId)
  }
  async cancel(sender: WebContents, input: { selectionId: string }): Promise<void> {
    const selection = this.selections.get(input.selectionId)
    if (selection && selection.senderId !== sender.id) throw new Error("安装确认属于其他窗口。")
    await this.release(input.selectionId)
  }
  clear(): void {
    for (const id of this.selections.keys()) void this.release(id)
    this.operations.clear()
  }
  private async release(id: string): Promise<void> {
    const selection = this.selections.get(id)
    if (!selection) return
    this.selections.delete(id)
    clearTimeout(selection.timer)
    try {
      await (
        await this.client()
      ).plugins.marketplaceCancel({ candidateId: selection.preview.candidateId })
    } catch {
      /* server also expires candidates */
    }
  }
}
