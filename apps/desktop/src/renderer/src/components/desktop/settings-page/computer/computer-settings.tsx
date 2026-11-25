import { useEffect, useState } from "react"
import { Copy } from "lucide-react"
import { MotionSwitch } from "@renderer/components/motion/switch"
import { Button } from "@renderer/components/ui/button"
import { Kbd } from "@renderer/components/ui/kbd"
import { toast } from "@renderer/lib/toast"
import type { DesktopComputerAppGrant, DesktopComputerAvailability, DesktopComputerSettings, DesktopComputerSettingsUpdate } from "@shared/computer-types"
import { errorMessage } from "../shared/settings-error-message"
import { SettingsGroup, SettingsRow } from "../shared/settings-group"
import { SettingsStatus, type SettingsStatusTone } from "../shared/settings-status"

type LocalStatus = DesktopComputerAvailability | "checking" | "check_failed" | "restart_required"

const localStatus: Record<LocalStatus, { label: string; tone: SettingsStatusTone; detail?: string }> = {
  checking: { label: "正在检查本机状态…", tone: "neutral" },
  ready: { label: "驱动已就绪", tone: "success", detail: "发起电脑操作时会核对后台连接和应用授权。" },
  disabled: { label: "电脑控制已停用", tone: "neutral" },
  missing_driver: { label: "驱动不可用", tone: "warning", detail: "驱动资源缺失或校验失败。请重新安装经过核验的版本。" },
  unsupported: { label: "当前平台暂不支持", tone: "neutral", detail: "目前仅支持 Windows x64 桌面版。" },
  check_failed: { label: "无法检查本机状态", tone: "error", detail: "请稍后重新打开此页面。" },
  restart_required: { label: "需要重启桌面应用", tone: "warning", detail: "请完整重启 Vykor 后使用电脑控制开关。" },
}

const examples = [
  { title: "用计算器算数", prompt: "打开计算器，算一下 7 × 8，并告诉我结果。" },
  { title: "在记事本写一行", prompt: "打开记事本，在空白文档里输入「今天完成了电脑操作测试」，然后读回确认。" },
  { title: "查看画图窗口", prompt: "打开画图，查看当前画布，并把窗口截图发到这条对话里。" },
]

async function copyExample(prompt: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(prompt)
    toast.success("示例已复制")
  } catch {
    toast.error("复制失败", "请重试。")
  }
}

export function ComputerSettings(): React.JSX.Element {
  const computer = window.desktop?.computer
  const canReadSettings = typeof computer?.getSettings === "function"
  const canUpdateSettings = typeof computer?.updateSettings === "function"
  const canListGrants = typeof computer?.listAppGrants === "function"
  const [settings, setSettings] = useState<DesktopComputerSettings>()
  const [statusCheckFailed, setStatusCheckFailed] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState<DesktopComputerSettingsUpdate>()
  const [grants, setGrants] = useState<DesktopComputerAppGrant[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)

  useEffect(() => {
    if (!computer) return
    let active = true
    if (canReadSettings) {
      void computer.getSettings().then(
        (result) => { if (active) setSettings(result) },
        () => { if (active) setStatusCheckFailed(true) },
      )
    }
    if (canListGrants) {
      void computer.listAppGrants().then(
        (result) => { if (active) setGrants(result) },
        (failure) => { if (active) setError(errorMessage(failure)) },
      )
    }
    return () => { active = false }
  }, [computer, canReadSettings, canListGrants])

  async function updateSetting(setting: DesktopComputerSettingsUpdate["setting"], value: boolean) {
    if (!computer || !canUpdateSettings) return
    setSaving({ setting, value })
    setSettingsError(null)
    try {
      setSettings(await computer.updateSettings({ setting, value }))
    } catch (failure) {
      setSettingsError(errorMessage(failure))
    } finally {
      setSaving(undefined)
    }
  }

  async function revoke(id: string) {
    if (typeof computer?.revokeAppGrant !== "function") return
    setRevoking(true)
    setError(null)
    try {
      setGrants(await computer.revokeAppGrant(id))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setRevoking(false)
    }
  }

  const initialStatus = computer && !canReadSettings ? "restart_required"
    : canReadSettings && !statusCheckFailed ? "checking" : "check_failed"
  const status = settings?.availability ?? initialStatus
  const { label, tone, detail } = localStatus[status]
  const grantError = canListGrants ? error : "无法读取应用授权。"
  const inputRelease = settings?.inputRelease
  const switchDisabled = Boolean(!canUpdateSettings || saving || !settings || settings.locked || inputRelease)
  const stopping = saving?.setting === "enabled" && !saving.value

  return (
    <>
      <SettingsGroup title="本机控制" id="computer-local-status" separated>
        <div role="status" className="space-y-1 py-3">
          <SettingsStatus tone={tone}>{label}</SettingsStatus>
          {detail ? <p className="text-xs leading-5 text-muted-foreground">{detail}</p> : null}
          {settings && !canUpdateSettings ? (
            <p className="text-xs leading-5 text-muted-foreground">{localStatus.restart_required.detail}</p>
          ) : null}
          {settings?.locked === "launch_disabled" ? (
            <p className="text-xs leading-5 text-muted-foreground">当前启动配置已禁用电脑控制。</p>
          ) : null}
          {stopping ? <p className="text-xs text-muted-foreground">正在停用电脑控制并等待键鼠释放…</p> : null}
          {inputRelease === "unconfirmed" ? (
            <p className="text-xs leading-5 text-destructive">无法确认键鼠已释放。请重启 Vykor 后再启用。</p>
          ) : null}
        </div>
        <SettingsRow
          title="允许电脑控制"
          description="允许助手在主聊天中按任务操作本机应用。关闭会结束正在进行的电脑控制。"
          labelFor="computer-enabled"
          control={
            <MotionSwitch id="computer-enabled" checked={settings?.enabled ?? false} disabled={switchDisabled}
              onCheckedChange={(value) => void updateSetting("enabled", value)} />
          }
        />
        <SettingsRow
          title="始终前台接管"
          description="下次电脑操作任务起，执行控件操作前也会把目标窗口切到前台。只读查看时保持原有方式。"
          labelFor="computer-always-foreground"
          control={
            <MotionSwitch id="computer-always-foreground" checked={settings?.alwaysForeground ?? false}
              disabled={switchDisabled || status !== "ready"}
              onCheckedChange={(value) => void updateSetting("alwaysForeground", value)} />
          }
        />
        {settingsError ? <p role="alert" className="py-3 text-sm text-destructive">{settingsError}</p> : null}
      </SettingsGroup>

      <SettingsGroup
        title="始终允许的应用"
        id="computer-app-grants"
        description="访问这些应用时会沿用已保存的应用授权。具体操作仍遵循当前聊天的批准方式。"
        separated
      >
        {grantError ? <p role="alert" className="py-3 text-sm text-destructive">{grantError}</p> : null}
        {!grantError && (!grants || grants.length === 0) ? (
          <p className="py-3 text-sm text-muted-foreground">
            {grants ? "没有已授权的应用。在聊天里选择「始终允许」后，应用会出现在这里。" : "正在读取应用授权…"}
          </p>
        ) : null}
        {grants?.map((grant) => (
          <SettingsRow
            key={grant.id}
            title={grant.name}
            control={
              <Button
                variant="outline"
                shape="pill"
                size="sm"
                disabled={revoking || typeof computer?.revokeAppGrant !== "function"}
                aria-label={`撤销 ${grant.name} 的访问许可`}
                onClick={() => void revoke(grant.id)}
              >
                撤销
              </Button>
            }
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="使用方法" id="computer-usage" description="复制一条示例，或在主聊天里直接描述任务。" separated>
        {examples.map(({ title, prompt }) => (
          <SettingsRow key={title} title={title} description={prompt} control={
            <Button type="button" variant="ghost" size="sm" shape="pill"
              aria-label={`复制${title}示例`} onClick={() => void copyExample(prompt)}>
              <Copy strokeWidth={1.75} data-icon="inline-start" />
              复制
            </Button>
          } />
        ))}
        <p className="py-3 text-xs leading-5 text-muted-foreground">
          前台控制时按 <Kbd>Esc</Kbd> 停止电脑操作。
        </p>
      </SettingsGroup>
    </>
  )
}
