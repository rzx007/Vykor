import { toast } from "@renderer/lib/toast"
import { useEffect, useRef, useState } from "react"
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
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Switch } from "@renderer/components/ui/switch"
import type {
  DesktopPermissionSettingsSnapshot,
  RevokeDesktopApprovalInput,
} from "@shared/permission-settings-types"
import { DefaultPermissionControl } from "./general-quick-controls"
import { SettingsGroup, SettingsRow } from "./settings-group"
import { PermissionApprovalsDialog } from "./permission-approvals-dialog"
import { errorMessage } from "./settings-error-message"

export function PermissionSettings() {
  const [snapshot, setSnapshot] = useState<DesktopPermissionSettingsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    title: string
    description: string
    action: string
    apply(): Promise<void>
  } | null>(null)
  const locked = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void window.desktop.permissionSettings.snapshot().then(
      (value) => {
        if (mounted.current) setSnapshot(value)
      },
      (failure) => {
        if (mounted.current) setError(errorMessage(failure))
      }
    )
    return () => {
      mounted.current = false
    }
  }, [])

  async function run(operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure))
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function accept(value: DesktopPermissionSettingsSnapshot, message: string) {
    if (!mounted.current) return
    setSnapshot(value)
    if (message) toast.success(message)
  }

  function changeProtection(enabled: boolean) {
    if (!snapshot || busy) return
    const expectedSandbox = snapshot.sandbox
    setConfirmation({
      title: enabled ? "开启文件与网络保护？" : "关闭文件与网络保护？",
      description: enabled
        ? "后续命令按已有访问规则运行；无法提供保护时停止执行。已有任务不变。"
        : "后续命令不再使用这层保护，批准方式和已有规则不变。已有任务不受影响。",
      action: enabled ? "开启保护" : "关闭保护",
      apply: async () =>
        accept(
          await window.desktop.permissionSettings.updateIsolation({
            sandbox: {
              ...expectedSandbox,
              enabled,
              // 无法提供保护时停止执行，不能悄悄放开访问。
              ...(enabled ? { failIfUnavailable: true } : {}),
            },
            expectedSandbox,
          }),
          "已保存，后续任务生效。"
        ),
    })
  }

  function revoke(input: RevokeDesktopApprovalInput) {
    setConfirmation({
      title: "撤销这项授权？",
      description:
        input.kind === "browser"
          ? "停止当前页面捕获，后续诊断需要重新批准。"
          : "此对话后续工具调用会重新检查权限，已完成操作不会撤回。",
      action: "确认撤销",
      apply: async () =>
        accept(await window.desktop.permissionSettings.revoke(input), "授权已撤销。"),
    })
  }

  if (!snapshot && !error)
    return (
      <div aria-label="正在读取权限设置" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-60 w-full" />
      </div>
    )

  const approvalCount = snapshot
    ? snapshot.toolApprovals.length + snapshot.browserApprovals.length
    : 0
  const hasCustomRules =
    snapshot &&
    Object.entries(snapshot.permission).some(
      ([key, value]) => key !== "mode" && Array.isArray(value) && value.length > 0
    )
  const protectionDescription = snapshot?.isolationAvailable
    ? "按已有规则限制命令访问；后续任务生效。"
    : snapshot?.sandbox.enabled
      ? snapshot.sandbox.failIfUnavailable
        ? "当前环境无法提供保护，命令将停止执行。"
        : "已保存开启，但当前环境无法提供保护。"
      : "当前运行环境暂不支持。"

  return (
    <div className="flex flex-col gap-8" aria-busy={busy}>
      {error && !approvalsOpen ? (
        <Alert variant="destructive">
          <AlertTitle>权限设置需要处理</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {snapshot ? (
        <>
          <SettingsGroup
            title="批准与访问"
            id="permission-basic-heading"
            separated
            action={
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    accept(await window.desktop.permissionSettings.snapshot(), "已重新读取。")
                    if (mounted.current) setRevision((current) => current + 1)
                  })
                }
              >
                重新读取
              </Button>
            }
          >
            <SettingsRow
              title="默认批准方式"
              labelFor="general-permission-mode"
              description="用于新对话，已有对话保持原设置。"
              control={<DefaultPermissionControl key={revision} disabled={busy} />}
            />
            <SettingsRow
              title="文件与网络保护"
              labelFor="permission-protection"
              description={protectionDescription}
              control={
                <Switch
                  id="permission-protection"
                  checked={snapshot.sandbox.enabled}
                  disabled={busy || (!snapshot.isolationAvailable && !snapshot.sandbox.enabled)}
                  onCheckedChange={changeProtection}
                />
              }
            />
            <SettingsRow
              title="浏览器诊断"
              labelFor="browser-developer-mode"
              description="允许请求页面诊断，每次仍需批准；关闭即停止捕获。"
              control={
                <Switch
                  id="browser-developer-mode"
                  checked={snapshot.browserDeveloperMode}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void run(async () => {
                      await window.desktop.settings.updateBrowserDeveloperMode({ enabled })
                      if (mounted.current) {
                        setSnapshot((current) =>
                          current ? { ...current, browserDeveloperMode: enabled } : current
                        )
                        toast.success("浏览器诊断已保存。")
                      }
                    })
                  }
                />
              }
            />
          </SettingsGroup>
          <SettingsGroup title="授权管理" separated>
            <SettingsRow
              title="已保存授权"
              description={
                approvalCount
                  ? `${approvalCount} 项授权可查看或撤销。`
                  : "暂无可撤销的工具或站点授权。"
              }
              control={
                <Button
                  id="permission-approvals-heading"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    setApprovalsOpen(true)
                  }}
                >
                  管理授权
                </Button>
              }
            />
          </SettingsGroup>
          {hasCustomRules ? (
            <p className="text-xs text-muted-foreground">已有自定义规则继续生效。</p>
          ) : null}
          <PermissionApprovalsDialog
            snapshot={snapshot}
            busy={busy}
            open={approvalsOpen}
            onOpenChange={setApprovalsOpen}
            error={error}
            onRevoke={revoke}
          />
        </>
      ) : (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => accept(await window.desktop.permissionSettings.snapshot(), ""))
          }
        >
          重新读取
        </Button>
      )}

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
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
              {confirmation?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
