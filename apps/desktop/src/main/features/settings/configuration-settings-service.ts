import { dialog } from "electron"
import { randomUUID } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { exportPortableSettings, parsePortableSettings } from "@vykor/server"
import type { SettingsImportPreview } from "../../../shared/configuration-settings-types"
import { desktopSessionService } from "../session/session-service"

const labels: Record<string, string> = {
  general: "常规",
  permission: "权限",
  memory: "个性化与记忆",
  model: "默认模型",
  environment: "运行环境",
}
export class ConfigurationSettingsService {
  async limits() {
    const settings = await (await desktopSessionService.daemonClient()).system.getSettings()
    if (!Number.isSafeInteger(settings.maxTurns) || Number(settings.maxTurns) < 1)
      throw new Error("后台未返回有效的任务轮数，请重新读取。")
    const editable = settings.maxTurnsEditable === true
    return {
      maxTurns: Number(settings.maxTurns),
      editable,
      reason: editable
        ? null
        : typeof settings.maxTurnsReason === "string"
          ? settings.maxTurnsReason
          : "当前后台未提供任务轮数设置，请重新连接后台。",
    }
  }
  async updateLimits(input: { maxTurns: number; expectedMaxTurns: number }) {
    if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 1000)
      throw new Error("任务轮数必须是 1–1000 的整数。")
    const current = await this.limits()
    if (!current.editable) throw new Error(current.reason ?? "当前任务轮数不可修改。")
    if (current.maxTurns !== input.expectedMaxTurns)
      throw new Error("任务轮数已被其他入口修改，请重新读取。")
    await (
      await desktopSessionService.daemonClient()
    ).system.patchSettings({ maxTurns: input.maxTurns, expectedMaxTurns: input.expectedMaxTurns })
    return this.limits()
  }
  private selections = new Map<
    string,
    {
      expires: number
      value: ReturnType<typeof parsePortableSettings>
      baseline: ReturnType<typeof parsePortableSettings>
    }
  >()
  async review() {
    const settings = await (await desktopSessionService.daemonClient()).system.getSettings()
    const mode = (settings.autoReview as { mode?: string } | undefined)?.mode
    return { mode: mode === "risk_based" ? ("risk_based" as const) : ("off" as const) }
  }
  async updateReview(input: { mode: "off" | "risk_based"; expected: "off" | "risk_based" }) {
    if (input.mode !== "off" && input.mode !== "risk_based") throw new Error("完成后检查选项无效。")
    if ((await this.review()).mode !== input.expected)
      throw new Error("完成后检查已被其他入口修改，请重新读取。")
    await (
      await desktopSessionService.daemonClient()
    ).system.patchSettings({
      autoReview: { mode: input.mode },
      expectedAutoReviewMode: input.expected,
    })
    return this.review()
  }
  async exportFile(categories: string[]) {
    const value = await exportPortableSettings()
    if (!categories.length || categories.some((category) => !Object.hasOwn(value.groups, category)))
      throw new Error("请选择有效设置分类。")
    value.groups = Object.fromEntries(
      Object.entries(value.groups).filter(([category]) => categories.includes(category))
    )
    const result = await dialog.showSaveDialog({
      title: "导出非机密配置",
      defaultPath: "vykor-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    })
    return result.filePath
  }
  async previewImport(): Promise<SettingsImportPreview | null> {
    const selected = await dialog.showOpenDialog({
      title: "导入配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    if ((await stat(selected.filePaths[0])).size > 2 * 1024 * 1024)
      throw new Error("配置文件超过 2 MiB，请选择正常的导出配置文件。")
    const value = parsePortableSettings(JSON.parse(await readFile(selected.filePaths[0], "utf8")))
    const previous = await exportPortableSettings()
    const id = randomUUID()
    for (const [key, entry] of this.selections)
      if (entry.expires < Date.now()) this.selections.delete(key)
    this.selections.set(id, { expires: Date.now() + 10 * 60_000, value, baseline: previous })
    return {
      id,
      name: basename(selected.filePaths[0]),
      groups: Object.entries(value.groups).map(([category, settings]) => ({
        id: category,
        label: labels[category] ?? category,
        changes: Object.entries(settings!).map(([key, after]) => ({
          key,
          before: JSON.stringify(
            previous.groups[category as keyof typeof previous.groups]?.[key] ?? null
          ),
          after: JSON.stringify(after),
        })),
      })),
    }
  }
  async applyImport(input: { id: string; categories: string[] }) {
    const selection = this.selections.get(input.id)
    if (!selection || selection.expires < Date.now())
      throw new Error("导入预览已失效，请重新选择文件。")
    const client = await desktopSessionService.daemonClient()
    const health = await client.protocol.health()
    if (health.activeRunCount || health.queuedRunCount)
      throw new Error("请等待任务结束后导入配置。")
    await client.system.patchSettings({
      importConfiguration: {
        value: selection.value,
        categories: input.categories,
        expected: selection.baseline,
      },
    })
    this.selections.delete(input.id)
  }
}
export const configurationSettingsService = new ConfigurationSettingsService()
