import { useEffect } from "react"
import { useRouterState } from "@tanstack/react-router"
import { GeneralSettings } from "./general-settings"
export { ReasoningVisibilityControl } from "./general-display-controls"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { ProviderSettings } from "./provider-settings"
import { PermissionSettings } from "./permission-settings"
import { StorageSettings } from "./storage-settings"
import { UsageSettings } from "./usage-settings"
import { DiagnosticsSettings } from "./diagnostics-settings"
import { TerminalSettings } from "./terminal-settings"
import { GitSettings } from "./git-settings"
import { RuntimeSettings } from "./runtime-settings"
import { NotificationSettings } from "./notification-settings"
import { AppearanceSettings } from "@renderer/components/appearance/appearance-settings"
import { ConnectionsSettings } from "./connections-settings"
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings"
import { ProfileSettings } from "./profile-settings"
import { PersonalizationSettings } from "./personalization-settings"

type SettingsContentProps = {
  selectedSection: string
}

const pages: Record<string, () => React.JSX.Element> = {
  常规: GeneralSettings,
  通知: NotificationSettings,
  个人资料: ProfileSettings,
  外观: AppearanceSettings,
  模型供应商: ProviderSettings,
  权限: PermissionSettings,
  个性化: PersonalizationSettings,
  键盘快捷键: KeyboardShortcutsSettings,
  用量与费用: UsageSettings,
  连接: ConnectionsSettings,
  终端: TerminalSettings,
  Git: GitSettings,
  运行环境: RuntimeSettings,
  存储: StorageSettings,
  诊断与日志: DiagnosticsSettings,
}
export function SettingsContent({ selectedSection }: SettingsContentProps): React.JSX.Element {
  const target = useRouterState({ select: (state) => state.location.hash })
  useEffect(() => {
    if (!target) return
    let observer: MutationObserver | undefined
    const reveal = () => {
      const element = document.getElementById(target)
      if (!element) return false
      let disclosure = element.closest("details")
      while (disclosure) {
        disclosure.open = true
        disclosure = disclosure.parentElement?.closest("details") ?? null
      }
      const row = element.closest('[data-slot="field"]') ?? element
      row.scrollIntoView({ block: "center", behavior: "auto" })
      const control = element.matches('input:not([type="hidden"]),button,textarea,select')
        ? element
        : row.querySelector<HTMLElement>(
            'button,[role="switch"],textarea,select,input:not([type="hidden"])'
          )
      ;(control as HTMLElement | null)?.focus({ preventScroll: true })
      observer?.disconnect()
      return true
    }
    if (reveal()) return
    observer = new MutationObserver(reveal)
    observer.observe(document.body, { childList: true, subtree: true })
    const timeout = setTimeout(() => observer?.disconnect(), 10_000)
    return () => {
      clearTimeout(timeout)
      observer?.disconnect()
    }
  }, [target, selectedSection])
  const Page = pages[selectedSection]
  const ownHeading = ["个人资料", "个性化", "通知", "终端", "Git"].includes(selectedSection)
  return (
    <ScrollArea
      horizontal={false}
      className="settings-page-shell h-full min-w-0 flex-1 bg-conversation"
    >
      {ownHeading && Page ? (
        <Page />
      ) : (
        <div className="settings-content-column">
          <header className="flex flex-col gap-2">
            <h1 className="font-heading text-xl tracking-tight">{selectedSection}</h1>
          </header>
          {Page ? <Page /> : <p className="text-sm text-muted-foreground">未找到此设置页面。</p>}
        </div>
      )}
    </ScrollArea>
  )
}
