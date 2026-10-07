import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopAppInfo } from "@shared/ipc-channels"
import { SettingsGroup, SettingsRow } from "./settings-group"
import { ProviderDefaultsControl } from "./provider-defaults-control"
import {
  WorkStyleControl,
  ReasoningVisibilityControl,
  ThemePreferenceControl,
  BrowserDeveloperControl,
} from "./general-display-controls"
import {
  DefaultPermissionControl,
  NotificationModeControl,
  RuntimeDefaultControl,
} from "./general-quick-controls"
import { AutoReviewControl, TaskLimitControl } from "./task-settings-controls"
import { DefaultOpenerControl } from "./default-opener-control"
import { DefaultTerminalShellControl } from "./default-terminal-shell-control"
import { DaemonAutoStartControl } from "./daemon-autostart-control"
import { ConfigurationSettings } from "./configuration-settings"

export function GeneralSettings() {
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    void window.desktop.app.getInfo().then((value) => {
      if (alive) setAppInfo(value)
    })
    return () => {
      alive = false
    }
  }, [])
  const refresh = () => useDesktopSessionStore.getState().refreshBootstrap()
  return (
    <div className="flex flex-col gap-8">
      <ProviderDefaultsControl key={`model-${revision}`} onChanged={refresh} />
      <SettingsGroup
        title="对话与任务"
        action={
          <Link
            to="/settings/$section"
            params={{ section: "permissions" }}
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            更多权限设置
          </Link>
        }
      >
        <div key={`tasks-${revision}`} className="divide-y divide-border">
          <SettingsRow
            title="工作风格"
            description="务实：关键节点同步；高效：必要时回复。"
            control={<WorkStyleControl />}
          />
          <SettingsRow
            title="思考过程"
            description="在对话中显示，可按需展开。"
            control={<ReasoningVisibilityControl />}
          />
          <SettingsRow
            title="默认批准方式"
            description="用于新会话，已有会话保持原设置。"
            control={<DefaultPermissionControl />}
          />
          <SettingsRow
            title="完成后自动检查"
            description="按风险进行只读审查，后续任务生效。"
            control={<AutoReviewControl />}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="应用与提醒"
        action={
          <Link
            to="/settings/$section"
            params={{ section: "notifications" }}
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            通知与音效
          </Link>
        }
      >
        <div key={`app-${revision}`} className="divide-y divide-border">
          <SettingsRow title="界面主题" control={<ThemePreferenceControl />} />
          <SettingsRow
            title="系统通知"
            description="任务完成、失败或需要你处理时提醒。"
            control={<NotificationModeControl />}
          />
          <SettingsRow
            title="默认打开应用"
            description="打开代码文件和文件夹时使用。"
            control={<DefaultOpenerControl />}
          />
          <SettingsRow
            title="后台持续运行"
            description="登录后启动后台服务，异常退出后恢复。"
            control={<DaemonAutoStartControl />}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="开发习惯"
        action={
          <Link
            to="/settings/$section"
            params={{ section: "runtime" }}
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            项目与环境设置
          </Link>
        }
      >
        <div key={`development-${revision}`} className="divide-y divide-border">
          <SettingsRow
            title="集成终端 Shell"
            description="用于新终端；自定义 Shell 优先。"
            control={<DefaultTerminalShellControl />}
          />
          <SettingsRow
            title="智能体默认环境"
            description="默认命令运行位置，项目可单独设置。"
            control={<RuntimeDefaultControl />}
          />
        </div>
      </SettingsGroup>
      <details className="group" id="general-advanced">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-sm text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>高级选项</span>
          <ChevronDown
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-4 flex flex-col gap-6">
          <SettingsGroup title="任务与开发">
            <div key={`advanced-${revision}`} className="divide-y divide-border">
              <SettingsRow
                title="默认任务轮数上限"
                description="每轮进行一次模型请求，控制任务的默认推进长度；项目可单独设置。"
                control={<TaskLimitControl />}
              />
              <SettingsRow
                title="浏览器开发者模式"
                description="允许页面诊断；每次仍需批准，关闭后停止捕获。"
                control={<BrowserDeveloperControl />}
              />
            </div>
          </SettingsGroup>
          <SettingsGroup title="配置迁移">
            <div className="py-4">
              <ConfigurationSettings
                onImported={() => {
                  setRevision((value) => value + 1)
                  void refresh().catch(() => undefined)
                }}
              />
            </div>
          </SettingsGroup>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            <Link
              className="underline underline-offset-4"
              to="/settings/$section"
              params={{ section: "personalization" }}
            >
              自定义指令与记忆
            </Link>
            <Link
              className="underline underline-offset-4"
              to="/settings/$section"
              params={{ section: "diagnostics" }}
            >
              诊断与日志
            </Link>
            <Link
              className="underline underline-offset-4"
              to="/settings/$section"
              params={{ section: "storage" }}
            >
              备份与恢复
            </Link>
            <Link
              className="underline underline-offset-4"
              to="/settings/$section"
              params={{ section: "keyboard" }}
            >
              键盘快捷键
            </Link>
          </div>
        </div>
      </details>
      <footer className="flex items-center justify-between gap-4 border-t pt-5 text-xs text-muted-foreground">
        <span>Vykor {appInfo?.version ?? "正在读取版本…"}</span>
        <Button variant="ghost" size="sm" onClick={() => setAboutOpen(true)}>
          关于 Vykor
        </Button>
      </footer>
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vykor</DialogTitle>
            <DialogDescription>本地项目与智能体协作工作区。</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>版本</dt>
            <dd>{appInfo?.version ?? "正在读取…"}</dd>
            <dt>运行方式</dt>
            <dd>{appInfo ? (appInfo.isPackaged ? "桌面安装包" : "开发模式") : "正在读取…"}</dd>
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  )
}
