import { ChevronDown, SlidersHorizontal } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card"
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
import { AttachmentStorageSettings } from "./attachment-storage-settings"
import { RuntimeSettingControl } from "./runtime-setting-control"
import { DefaultOpenerControl } from "./default-opener-control"
import { DefaultTerminalShellControl } from "./default-terminal-shell-control"
import { errorMessage } from "./settings-error-message"
import { DaemonAutoStartControl } from "./daemon-autostart-control"
import { AppearanceSettings } from "@renderer/components/appearance/appearance-settings"
import { McpSettings } from "./mcp-settings"
import { ConnectionsSettings } from "./connections-settings"
import { isDesktopNotificationMode, isDesktopWorkStyle } from "@shared/settings-types"
import type { DesktopNotificationMode, DesktopWorkStyle } from "@shared/settings-types"
import type { DesktopAppInfo } from "@shared/ipc-channels"

type SettingsContentProps = {
  selectedSection: string
}

export function SettingsContent({ selectedSection }: SettingsContentProps): React.JSX.Element {
  return (
    <ScrollArea horizontal={false} className="h-full min-w-0 flex-1 bg-conversation">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-10 py-16 lg:px-16">
        <header className="flex flex-col gap-2">
          <h1 className="font-heading text-xl tracking-tight">{selectedSection}</h1>
          <p className="text-sm text-muted-foreground">
            {selectedSection === "常规"
              ? "调整 OpenHarness 的默认工作方式。工作风格会保存到全局配置，并用于后续任务。"
              : selectedSection === "供应商"
                ? "连接模型服务和开发工具订阅，选择 OpenHarness 默认使用的供应商。"
                : selectedSection === "外观"
                  ? "调整 OpenHarness 在当前设备上的显示方式。更改会立即预览并自动保存。"
                  : selectedSection === "MCP 服务"
                    ? "查看已配置的 MCP 服务，并通过浏览器完成 OAuth 登录或撤销本地授权。"
                  : selectedSection === "连接"
                    ? "把飞书接入 OpenHarness：扫码或手填创建机器人，管理白名单，并查看真实连接状态。"
                  : selectedSection === "存储"
                    ? "查看并维护当前设备上的对话附件存储。"
                    : `${selectedSection}页面将在后续迭代中接入。`}
          </p>
        </header>

        {selectedSection === "常规" ? (
          <GeneralSettings />
        ) : selectedSection === "供应商" ? (
          <ProviderSettings />
        ) : selectedSection === "外观" ? (
          <AppearanceSettings />
        ) : selectedSection === "存储" ? (
          <AttachmentStorageSettings />
        ) : selectedSection === "MCP 服务" ? (
          <McpSettings />
        ) : selectedSection === "连接" ? (
          <ConnectionsSettings />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{selectedSection}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <SlidersHorizontal className="size-8" strokeWidth={1.5} />
                <p className="text-sm">这一页先保留导航与布局，具体设置项后续再补。</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
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
      <SettingsSection title="权限">
        <SettingRow
          title="默认权限"
          description="允许智能体读取和编辑当前工作区中的文件；需要访问工作区之外的位置时再向你请求。"
          control={<Switch aria-label="默认权限" defaultChecked />}
        />
        <Separator />
        <SettingRow
          title="自动审核"
          description="在执行工具之前自动判断风险，遇到敏感操作仍会请求你的确认。"
          control={<Switch aria-label="自动审核" defaultChecked />}
        />
        <Separator />
        <SettingRow
          title="完整访问权限"
          description="允许智能体在无需逐次批准的情况下访问工作区外的文件和网络。"
          control={<Switch aria-label="完整访问权限" />}
        />
      </SettingsSection>

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
          title="通知"
          description="选择任务完成、失败或需要你处理时是否发送系统通知。"
          control={<NotificationModeControl />}
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
        <SettingRow
          title="运行环境"
          description="选择智能体的命令、脚本、文件工具和终端在本机还是 WSL 中运行。WSL 仅在 Windows 上可用，更改会在重启后生效。"
          control={<RuntimeSettingControl />}
        />
        <Separator />
        <SettingRow
          title="集成终端 Shell"
          description="本机环境使用这里选择的 Shell；WSL 环境使用 Linux 发行版的默认 Shell。"
          control={<DefaultTerminalShellControl />}
        />
        <Separator />
        <SettingRow
          title="界面语言"
          description="OpenHarness 桌面应用使用的语言"
          control={<SettingSelect label="简体中文" />}
        />
        <Separator />
        <SettingRow
          title="桌面宠物"
          description="启动应用时显示桌面宠物"
          control={<Switch aria-label="桌面宠物" defaultChecked />}
        />
        <Separator />
        <SettingRow
          title="运行速度"
          description="选择智能体执行任务时的默认速度"
          control={<SettingSelect label="标准" />}
        />
        <Separator />
        <SettingRow
          title="提示词建议"
          description="根据当前项目和对话内容建议下一步操作"
          control={<Switch aria-label="提示词建议" />}
        />
        <Separator />
        <SettingRow
          title="导入设置"
          description="从已有的 OpenHarness 配置中恢复偏好"
          control={
            <Button variant="secondary" size="sm">
              再次导入
            </Button>
          }
        />
        <Separator />
        <SettingRow
          title="关于 OpenHarness"
          description={versionLabel}
          control={
            <Button variant="ghost" size="sm" onClick={() => setAboutOpen(true)}>
              查看详情
            </Button>
          }
        />
      </SettingsSection>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenHarness</DialogTitle>
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

const notificationModeLabels = {
  never: "从不",
  when_unfocused: "仅失去焦点时",
  always: "始终",
} satisfies Record<DesktopNotificationMode, string>

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

function NotificationModeControl(): React.JSX.Element {
  const [mode, setMode] = useState<DesktopNotificationMode>("when_unfocused")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setMode(snapshot.notificationMode)
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

  const update = (nextMode: DesktopNotificationMode): void => {
    if (saving || nextMode === mode) return
    const previous = mode
    setMode(nextMode)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateNotificationMode({ notificationMode: nextMode })
      .then((snapshot) => setMode(snapshot.notificationMode))
      .catch((saveError: unknown) => {
        setMode(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={mode}
        onValueChange={(value) => {
          if (isDesktopNotificationMode(value)) update(value)
        }}
      >
        <SelectTrigger aria-label="通知" disabled={loading || saving} className="min-w-36">
          <SelectValue>{notificationModeLabels[mode]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="never">从不</SelectItem>
            <SelectItem value="when_unfocused">仅失去焦点时</SelectItem>
            <SelectItem value="always">始终</SelectItem>
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
      <Card className="py-0">
        <CardHeader className="sr-only">
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="px-5">{children}</CardContent>
      </Card>
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

function SettingSelect({
  icon,
  label,
}: {
  icon?: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="sm" className="min-w-28 justify-between">
      {icon}
      <span>{label}</span>
      <ChevronDown data-icon="inline-end" />
    </Button>
  )
}
