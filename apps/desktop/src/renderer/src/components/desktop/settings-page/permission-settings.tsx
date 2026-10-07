import { SettingsGroup } from "./settings-group"
import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Alert, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@renderer/components/ui/alert-dialog"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@renderer/components/ui/field"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Switch } from "@renderer/components/ui/switch"
import type {
  DesktopPermissionRules,
  DesktopPermissionSettingsSnapshot,
  DesktopIsolationSettings,
  RevokeDesktopApprovalInput,
} from "@shared/permission-settings-types"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { errorMessage } from "./settings-error-message"
import { PermissionRulesEditor } from "./permission-settings-rules"
import { PermissionIsolationEditor } from "./permission-settings-isolation"

export function PermissionSettings() {
  const [snapshot, setSnapshot] = useState<DesktopPermissionSettingsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const [rulesRevision, setRulesRevision] = useState(0)
  const [isolationRevision, setIsolationRevision] = useState(0)
  const [confirmation, setConfirmation] = useState<{
    description: string
    apply(): Promise<void>
  } | null>(null)
  const locked = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void window.desktop.permissionSettings
      .snapshot()
      .then((value) => {
        if (mounted.current) setSnapshot(value)
      })
      .catch((failure) => {
        if (mounted.current) setError(errorMessage(failure))
      })
    return () => {
      mounted.current = false
    }
  }, [])

  async function run(operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    setFeedback("")
    try {
      await operation()
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure))
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function accept(
    value: DesktopPermissionSettingsSnapshot,
    message: string,
    reset: "rules" | "isolation" | "all" | "none" = "none"
  ) {
    if (!mounted.current) return
    setSnapshot(value)
    if (reset === "rules" || reset === "all") setRulesRevision((current) => current + 1)
    if (reset === "isolation" || reset === "all") setIsolationRevision((current) => current + 1)
    setFeedback(message)
  }

  function saveRules(
    permission: DesktopPermissionRules,
    expectedPermission: DesktopPermissionRules
  ) {
    if (!snapshot) return
    const apply = async () => {
      const next = await window.desktop.permissionSettings.update({
        permission,
        expectedPermission,
      })
      accept(next, "已保存，新会话采用批准方式，后续任务采用规则。", "rules")
      try {
        await useDesktopSessionStore.getState().refreshBootstrap()
      } catch {
        if (mounted.current) setError("权限设置已保存，但会话默认值刷新失败。请重新打开应用。")
      }
    }
    if (permission.mode === "full_auto" && expectedPermission.mode !== "full_auto") {
      setConfirmation({
        description: "新会话不再逐项询问，仍遵守禁止规则和访问边界。",
        apply,
      })
    } else void run(apply)
  }

  function saveIsolation(
    sandbox: DesktopIsolationSettings,
    expectedSandbox: DesktopIsolationSettings
  ) {
    if (!snapshot) return
    const apply = async () =>
      accept(
        await window.desktop.permissionSettings.updateIsolation({
          sandbox,
          expectedSandbox,
        }),
        "已保存，后续任务生效。",
        "isolation"
      )
    setConfirmation({
      description: "将修改后续命令的访问范围；已有任务不变。请核对目录、域名和隔离策略。",
      apply,
    })
  }

  function revoke(input: RevokeDesktopApprovalInput) {
    setConfirmation({
      description: "后续操作需重新批准，已完成操作不回滚；浏览器捕获将停止。",
      apply: async () =>
        accept(await window.desktop.permissionSettings.revoke(input), "授权已撤销。"),
    })
  }

  if (!snapshot && !error)
    return (
      <div aria-label="正在读取权限设置" className="flex flex-col gap-5">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )

  return (
    <div className="flex flex-col gap-8" aria-busy={busy}>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>权限设置需要处理</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">用户默认值，可被项目或会话覆盖。</p>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              accept(
                await window.desktop.permissionSettings.snapshot(),
                "已重新读取权限设置。",
                "all"
              )
            )
          }
        >
          重新读取
        </Button>
      </div>
      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <PermissionRulesEditor
            key={`rules-${rulesRevision}`}
            permission={snapshot.permission}
            busy={busy}
            onSave={saveRules}
            defaultCwd={useDesktopSessionStore.getState().selectedProject?.path ?? ""}
          />
          <PermissionIsolationEditor
            key={`isolation-${isolationRevision}`}
            sandbox={snapshot.sandbox}
            available={snapshot.isolationAvailable}
            reason={snapshot.isolationReason}
            busy={busy}
            onSave={saveIsolation}
          />
          <SettingsGroup title="浏览器" id="permission-browser-heading">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="browser-developer-mode">浏览器开发者模式</FieldLabel>
                <FieldDescription>每次页面诊断需单独批准，关闭后立即停止捕获。</FieldDescription>
              </FieldContent>
              <Switch
                id="browser-developer-mode"
                checked={snapshot.browserDeveloperMode}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  void run(async () => {
                    await window.desktop.settings.updateBrowserDeveloperMode({ enabled })
                    // Do not reset unrelated rule drafts when toggling this independent preference.
                    if (mounted.current) {
                      setSnapshot((current) =>
                        current ? { ...current, browserDeveloperMode: enabled } : current
                      )
                      setFeedback("浏览器开发者模式已保存。")
                    }
                  })
                }
              />
            </Field>
          </SettingsGroup>
          <SettingsGroup title="已保存授权" id="permission-approvals-heading">
            <p className="text-sm text-muted-foreground">
              工具授权由后台保存；站点授权仅本次运行有效。单次批准不列出。
            </p>
            {snapshot.toolApprovals.length === 0 && snapshot.browserApprovals.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可复用的工具或浏览器授权。</p>
            ) : null}
            {snapshot.toolApprovals.map((approval) => (
              <div key={approval.id} className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{approval.toolName}</p>
                  <p className="text-xs break-all text-muted-foreground">
                    会话 {approval.sessionId} · 仅本会话及允许继承的子任务
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => revoke({ kind: "tool", id: approval.id })}
                >
                  撤销
                </Button>
              </div>
            ))}
            {snapshot.browserApprovals.map((approval) => (
              <div
                key={`${approval.sessionId}:${approval.origin}`}
                className="flex items-center gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-all">{approval.origin}</p>
                  <p className="text-xs break-all text-muted-foreground">
                    会话 {approval.sessionId} · 当前应用运行期间
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => revoke({ kind: "browser", ...approval })}
                >
                  撤销
                </Button>
              </div>
            ))}
            <Link to="/plugins" className="text-sm underline underline-offset-4">
              在插件管理中查看和重新审核插件权限
            </Link>
          </SettingsGroup>
        </>
      ) : null}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认权限变更</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const action = confirmation?.apply
                setConfirmation(null)
                if (action) void run(action)
              }}
            >
              确认变更
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
