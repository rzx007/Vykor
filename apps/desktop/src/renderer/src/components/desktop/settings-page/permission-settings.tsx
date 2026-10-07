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
import { Separator } from "@renderer/components/ui/separator"
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
      accept(next, "权限设置已保存。新会话采用默认批准方式，规则由后续任务读取。", "rules")
      try {
        await useDesktopSessionStore.getState().refreshBootstrap()
      } catch {
        if (mounted.current) setError("权限设置已保存，但会话默认值刷新失败。请重新打开应用。")
      }
    }
    if (permission.mode === "full_auto" && expectedPermission.mode !== "full_auto") {
      setConfirmation({
        description:
          "新会话将自动批准工具操作，仍遵守禁止规则和宿主访问边界。操作执行前将不再逐项询问。",
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
        "访问边界已保存，后续启动的任务采用新配置。",
        "isolation"
      )
    setConfirmation({
      description:
        "将修改后续命令进程的文件和网络边界。请核对允许目录、域名规则及隔离不可用时的策略；已有任务保持当前状态。",
      apply,
    })
  }

  function revoke(input: RevokeDesktopApprovalInput) {
    setConfirmation({
      description:
        "撤销后，后续相关操作需要重新取得批准。已经完成的操作不会回滚；浏览器诊断捕获会停止。",
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
        <p className="text-sm text-muted-foreground">
          编辑用户默认设置。项目和当前会话的单独选择可能覆盖默认值。
        </p>
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
          <Separator />
          <PermissionIsolationEditor
            key={`isolation-${isolationRevision}`}
            sandbox={snapshot.sandbox}
            available={snapshot.isolationAvailable}
            reason={snapshot.isolationReason}
            busy={busy}
            onSave={saveIsolation}
          />
          <Separator />
          <section aria-labelledby="permission-browser-heading" className="flex flex-col gap-4">
            <h2 id="permission-browser-heading" className="text-base font-semibold">
              浏览器
            </h2>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="browser-developer-mode">浏览器开发者模式</FieldLabel>
                <FieldDescription>
                  允许请求页面结构、控制台和网络诊断。每次检查仍需单独批准；关闭后立即停止捕获。
                </FieldDescription>
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
          </section>
          <Separator />
          <section aria-labelledby="permission-approvals-heading" className="flex flex-col gap-4">
            <h2 id="permission-approvals-heading" className="text-base font-semibold">
              已保存授权
            </h2>
            <p className="text-sm text-muted-foreground">
              会话工具授权由后台服务保存；浏览器站点授权仅保留在当前应用运行期间。单次批准不作为可复用授权列出。
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
          </section>
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
