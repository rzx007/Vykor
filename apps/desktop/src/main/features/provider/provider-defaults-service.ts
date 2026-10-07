import { testStoredProviderConnection, storedProviderConnectionFingerprint } from "@vykor/server"
import type { ProviderDefaultsSnapshot, UpdateProviderDefaultEffortInput, ProviderConnectionTestResult } from "../../../shared/provider-defaults-types"
import { desktopSessionService } from "../session/session-service"
import { resolveDesktopRuntimeSnapshot } from "../session/runtime-selection"

export class DesktopProviderDefaultsService {
  private readonly verified = new Map<string, { fingerprint: string; model: string; checkedAt: number }>()
  private updating = false

  async snapshot(): Promise<ProviderDefaultsSnapshot> {
    const client = await desktopSessionService.daemonClient()
    const [settings, providers] = await Promise.all([client.system.getSettings(), client.providers.listModels()])
    const models = providers.flatMap((provider) => provider.models)
    const runtime = resolveDesktopRuntimeSnapshot(models, settings)
    const verified: ProviderDefaultsSnapshot["verified"] = {}
    for (const [provider, value] of this.verified) {
      try {
        if (await storedProviderConnectionFingerprint(provider) === value.fingerprint) verified[provider] = { model: value.model, checkedAt: value.checkedAt }
        else this.verified.delete(provider)
      } catch { this.verified.delete(provider) }
    }
    const selected = { provider: typeof settings.provider === "string" ? settings.provider : null, model: typeof settings.model === "string" ? settings.model : null, effort: typeof settings.effort === "string" && settings.effort.trim() ? settings.effort.trim() : null, disabled: settings.modelDisabled === true }
    return { models, provider: selected.disabled ? null : runtime.defaultProvider ?? null, model: selected.disabled ? null : runtime.defaultModel ?? null, effort: selected.effort, disabled: selected.disabled, revision: JSON.stringify(selected), verified, fastModeAvailable: false, fastModeReason: "当前连接没有提供模型服务加速；快速回答偏好只调整回答方式，不代表请求加速。" }
  }

  async updateEffort(input: UpdateProviderDefaultEffortInput): Promise<ProviderDefaultsSnapshot> {
    if (!input || this.updating) throw new Error("默认模型正在保存，请稍后重试。")
    this.updating = true
    try {
      const current = await this.snapshot()
      if (current.revision !== input.expectedRevision) throw new Error("默认模型设置已变化，请重新读取后比较并重试。")
      const model = current.models.find((item) => item.providerName === current.provider && item.id === current.model)
      if (!model) throw new Error("请选择已配置供应商实际列出的模型。")
      if (input.effort !== null && !model.reasoningEfforts?.includes(input.effort)) throw new Error("所选模型不支持该推理强度；未知能力不发送推理参数。")
      const client = await desktopSessionService.daemonClient()
      await client.system.patchSettings({ effort: input.effort ?? "" })
      return await this.snapshot()
    } finally { this.updating = false }
  }

  async test(input: { provider: string; model: string }): Promise<ProviderConnectionTestResult> {
    const current = await this.snapshot()
    if (!input || !current.models.some((item) => item.providerName === input.provider && item.id === input.model)) throw new Error("请先选择供应商实际列出的模型。")
    try {
      const result = await testStoredProviderConnection(input)
      this.verified.set(input.provider, { ...result, model: input.model })
      return { status: "verified", checkedAt: result.checkedAt, detail: "模型列表接口验证通过。此结果不代表模型生成请求一定成功；修改凭据或连接信息后失效。" }
    } catch (failure) {
      this.verified.delete(input.provider)
      const message = failure instanceof Error ? failure.message : "验证失败。"
      const category = /密钥|访问权限/.test(message) ? "authentication" : /模型不支持/.test(message) ? "model" : /Base URL|验证接口.*不可用/.test(message) && !/无法连接/.test(message) ? "address" : /无法连接/.test(message) ? "network" : /没有独立/.test(message) ? "unsupported" : "service"
      return { status: "failed", category, checkedAt: Date.now(), detail: message }
    }
  }
}
export const desktopProviderDefaultsService = new DesktopProviderDefaultsService()
