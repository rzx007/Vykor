import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Separator } from "@renderer/components/ui/separator"
import { Switch } from "@renderer/components/ui/switch"
import { ProviderSettings } from "./provider-settings"
import { PermissionSettings } from "./permission-settings"
import { StorageSettings } from "./storage-settings"
import { UsageSettings } from "./usage-settings"
import { DiagnosticsSettings } from "./diagnostics-settings"
import { TerminalSettings } from "./terminal-settings"
import { GitSettings } from "./git-settings"
import { RuntimeSettings } from "./runtime-settings"
import { ConfigurationSettings } from "./configuration-settings"
import { NotificationSettings } from "./notification-settings"
import { Link, useRouterState } from "@tanstack/react-router"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { DefaultOpenerControl } from "./default-opener-control"
import { errorMessage } from "./settings-error-message"
import { DaemonAutoStartControl } from "./daemon-autostart-control"
import { AppearanceSettings } from "@renderer/components/appearance/appearance-settings"
import { ConnectionsSettings } from "./connections-settings"
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings"
import { ProfileSettings } from "./profile-settings"
import { PersonalizationSettings } from "./personalization-settings"
import { isDesktopWorkStyle } from "@shared/settings-types"
import type { DesktopWorkStyle } from "@shared/settings-types"
import type { DesktopAppInfo } from "@shared/ipc-channels"

type SettingsContentProps = {
  selectedSection: string
}

const pages: Record<string, () => React.JSX.Element> = {
  常规: GeneralSettings, 通知: NotificationSettings, 个人资料: ProfileSettings, 外观: AppearanceSettings,
  模型供应商: ProviderSettings, 权限: PermissionSettings, 个性化: PersonalizationSettings,
  键盘快捷键: KeyboardShortcutsSettings, 用量与费用: UsageSettings, 连接: ConnectionsSettings,
  终端: TerminalSettings, Git: GitSettings, 运行环境: RuntimeSettings, 存储: StorageSettings, 诊断与日志: DiagnosticsSettings,
}
const descriptions: Record<string, string> = {
  常规: "调整默认工作方式、后台运行和配置。",
  外观: "调整当前设备的主题、颜色、字体和动效。",
  模型供应商: "管理模型连接、默认模型和实际支持的请求偏好。",
  权限: "管理批准方式、工具规则、访问边界和已保存授权。",
  键盘快捷键: "搜索、修改和恢复常用操作的按键组合。",
  用量与费用: "查看真实请求用量、统计完整性和费用依据。",
  连接: "管理消息渠道及其使用权限。",
  运行环境: "查看实际执行位置，配置项目环境和命令设置。",
  存储: "查看空间占用，维护、备份和恢复应用数据。",
  诊断与日志: "检查后台服务、环境和连接，查看并导出诊断信息。",
}
export function SettingsContent({ selectedSection }: SettingsContentProps): React.JSX.Element {
  const target = useRouterState({ select: state => state.location.hash })
  useEffect(() => {
    if (!target) return
    let observer: MutationObserver | undefined
    const reveal = () => {
      const element = document.getElementById(target)
      if (!element) return false
      const row = element.closest('[data-slot="field"]') ?? element
      row.scrollIntoView({ block: "center", behavior: "auto" })
      const control = element.matches('input:not([type="hidden"]),button,textarea,select') ? element : row.querySelector<HTMLElement>('button,[role="switch"],textarea,select,input:not([type="hidden"])')
      ;(control as HTMLElement | null)?.focus({ preventScroll: true })
      observer?.disconnect()
      return true
    }
    if (reveal()) return
    observer = new MutationObserver(reveal)
    observer.observe(document.body, { childList: true, subtree: true })
    const timeout = setTimeout(() => observer?.disconnect(), 10_000)
    return () => { clearTimeout(timeout); observer?.disconnect() }
  }, [target, selectedSection])
  const Page = pages[selectedSection]
  const ownHeading = ["个人资料", "个性化", "通知", "终端", "Git"].includes(selectedSection)
  return (
    <ScrollArea horizontal={false} className="h-full min-w-0 flex-1 bg-conversation">
      {ownHeading && Page ? <Page /> : (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12 sm:px-10 lg:px-16">
          <header className="flex flex-col gap-2">
            <h1 className="font-heading text-xl tracking-tight">{selectedSection}</h1>
            <p className="text-sm text-muted-foreground">{descriptions[selectedSection] ?? "查看和调整应用设置。"}</p>
          </header>
          {Page ? <Page /> : <p className="text-sm text-muted-foreground">未找到此设置页面。</p>}
        </div>
      )}
    </ScrollArea>
  )
}

function GeneralSettings(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.desktop.app.getInfo().then((info) => {
      if (!cancelled) setAppInfo(info)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const versionLabel = appInfo ? `版本 ${appInfo.version}` : "正在读取版本…"

  return (
    <div className="flex flex-col gap-10">
      <SettingsSection title="常规">
        <SettingRow
          title="工作风格"
          description="务实会在开工和关键节点简要同步；高效会直接执行，只在需要你决定、遇到风险或完成时回复。两种风格都会完整调查、修改和验证。"
          control={<WorkStyleControl />}
        />
        <Separator />
        <SettingRow
          title="思考过程"
          description="在对话中展示模型的思考过程（默认收起，点击展开）。"
          control={<ReasoningVisibilityControl />}
        />
        <Separator />
        <SettingRow
          title="后台持续运行"
          description="登录系统后自动启动 daemon，并在异常退出后恢复，让定时任务和后台工作持续执行。"
          control={<DaemonAutoStartControl />}
        />
        <Separator />
        <SettingRow
          title="默认文件打开目标"
          description="选择打开代码文件和文件夹时使用的应用"
          control={<DefaultOpenerControl />}
        />
        <Separator />
        <SettingRow title="默认模型" description="在模型供应商中调整默认模型和支持的推理强度。" control={<DefaultModelLink />} />
        <Separator />
        <SettingRow
          title="关于 Vykor"
          description={versionLabel}
          control={
            <Button variant="ghost" size="sm" onClick={() => setAboutOpen(true)}>
              查看详情
            </Button>
          }
        />
      </SettingsSection>

      <ConfigurationSettings />

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vykor</DialogTitle>
            <DialogDescription>面向本地项目和智能代理协作的桌面工作区。</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg bg-muted/55 p-3 text-xs">
            <dt className="text-muted-foreground">版本</dt>
            <dd>{appInfo?.version ?? "正在读取…"}</dd>
            <dt className="text-muted-foreground">运行方式</dt>
            <dd>{appInfo ? (appInfo.isPackaged ? "桌面安装包" : "开发模式") : "正在读取…"}</dd>
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DefaultModelLink(): React.JSX.Element {
  const model = useDesktopSessionStore(state => state.defaultModel)
  return <Link to="/settings/$section" params={{ section: "providers" }} className="text-sm underline underline-offset-4">{model ?? "选择默认模型"}</Link>
}

function WorkStyleControl(): React.JSX.Element {
  const [style, setStyle] = useState<DesktopWorkStyle>("practical")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setStyle(snapshot.workStyle)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (nextStyle: DesktopWorkStyle): void => {
    if (saving || nextStyle === style) return
    const previous = style
    setStyle(nextStyle)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateWorkStyle({ workStyle: nextStyle })
      .then((snapshot) => setStyle(snapshot.workStyle))
      .catch((saveError: unknown) => {
        setStyle(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={style}
        onValueChange={(value) => {
          if (isDesktopWorkStyle(value)) update(value)
        }}
      >
        <SelectTrigger aria-label="工作风格" disabled={loading || saving} className="min-w-28">
          <SelectValue>{style === "practical" ? "务实" : "高效"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="practical">务实</SelectItem>
            <SelectItem value="efficient">高效</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function ReasoningVisibilityControl(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setEnabled(snapshot.showReasoning)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: boolean): void => {
    if (saving || next === enabled) return
    const previous = enabled
    setEnabled(next)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateReasoningVisibility({ showReasoning: next })
      .then((snapshot) => setEnabled(snapshot.showReasoning))
      .catch((saveError: unknown) => {
        setEnabled(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        aria-label="思考过程"
        checked={enabled}
        disabled={loading || saving}
        onCheckedChange={update}
      />
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function SettingsSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`settings-${title}`}>
      <h2 id={`settings-${title}`} className="font-heading text-lg font-semibold">
        {title}
      </h2>
      <div>{children}</div>
    </section>
  )
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-20 items-center gap-6 py-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
