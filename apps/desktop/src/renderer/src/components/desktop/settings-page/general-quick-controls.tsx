import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import type { DesktopNotificationMode } from "@shared/settings-types"
import { isDesktopNotificationMode } from "@shared/settings-types"
import type { DesktopPermissionRules } from "@shared/permission-settings-types"
import type { RuntimeSettingsSnapshot } from "@shared/runtime-settings-types"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { errorMessage } from "./settings-error-message"

const notificationModes: Record<DesktopNotificationMode, string> = {
  never: "从不",
  when_unfocused: "仅应用失去焦点时",
  always: "始终",
}

export function NotificationModeSelect({
  value,
  disabled,
  onChange,
}: {
  value: DesktopNotificationMode
  disabled?: boolean
  onChange(value: DesktopNotificationMode): void
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (isDesktopNotificationMode(next)) onChange(next)
      }}
    >
      <SelectTrigger disabled={disabled} aria-label="系统通知模式" className="min-w-40">
        <SelectValue>{notificationModes[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {Object.entries(notificationModes).map(([mode, label]) => (
            <SelectItem key={mode} value={mode}>
              {label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function NotificationModeControl() {
  const [mode, setMode] = useState<DesktopNotificationMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    void window.desktop.notificationSettings.snapshot().then(
      (value) => {
        if (alive) setMode(value.mode)
      },
      (failure) => {
        if (alive) setError(errorMessage(failure))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  async function update(next: DesktopNotificationMode) {
    if (!mode || busy || next === mode) return
    setBusy(true)
    setError("")
    try {
      setMode(
        (await window.desktop.notificationSettings.updateMode({ mode: next, expectedMode: mode }))
          .mode
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <NotificationModeSelect
        value={mode ?? "when_unfocused"}
        disabled={!mode || busy}
        onChange={(next) => void update(next)}
      />
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function DefaultPermissionControl() {
  const [permission, setPermission] = useState<DesktopPermissionRules | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState("")
  const locked = useRef(false)
  useEffect(() => {
    let alive = true
    void window.desktop.permissionSettings.snapshot().then(
      (value) => {
        if (alive) setPermission(value.permission)
      },
      (failure) => {
        if (alive) setError(errorMessage(failure))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  async function save(mode: DesktopPermissionRules["mode"]) {
    if (!permission || locked.current || mode === permission.mode) return
    locked.current = true
    setBusy(true)
    setError("")
    setConfirm(false)
    try {
      const saved = await window.desktop.permissionSettings.update({
        permission: { ...permission, mode },
        expectedPermission: permission,
      })
      setPermission(saved.permission)
      try {
        await useDesktopSessionStore.getState().refreshBootstrap()
      } catch {
        setError("权限已保存，会话列表刷新失败，请重新打开设置。")
      }
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={permission?.mode ?? "default"}
        onValueChange={(value) => {
          if (value !== "default" && value !== "plan" && value !== "full_auto") return
          if (value === "full_auto" && permission?.mode !== "full_auto") setConfirm(true)
          else void save(value)
        }}
      >
        <SelectTrigger
          id="general-permission-mode"
          aria-label="默认批准方式"
          disabled={!permission || busy}
          className="min-w-36"
        >
          <SelectValue>
            {permission?.mode === "full_auto"
              ? "自动批准"
              : permission?.mode === "plan"
                ? "只读计划"
                : "手动批准"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="default">手动批准</SelectItem>
            <SelectItem value="plan">只读计划</SelectItem>
            <SelectItem value="full_auto">自动批准</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>启用自动批准？</AlertDialogTitle>
            <AlertDialogDescription>
              新会话不再逐项询问，仍遵守禁止规则和访问边界。已有会话保持原设置。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void save("full_auto")}>
              启用自动批准
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function RuntimeDefaultControl() {
  const [snapshot, setSnapshot] = useState<RuntimeSettingsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    void window.desktop.runtimeSettings.snapshot().then(
      (value) => {
        if (alive) setSnapshot(value)
      },
      (failure) => {
        if (alive) setError(errorMessage(failure))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  async function save(kind: "native" | "wsl") {
    if (!snapshot || busy || kind === snapshot.userConfig.kind) return
    setBusy(true)
    setError("")
    try {
      setSnapshot(
        await window.desktop.runtimeSettings.save({
          config: { ...snapshot.userConfig, kind },
          expected: snapshot.userConfig,
        })
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={snapshot?.userConfig.kind ?? "native"}
        onValueChange={(value) => {
          if (value === "native" || value === "wsl") void save(value)
        }}
      >
        <SelectTrigger
          aria-label="智能体默认环境"
          disabled={!snapshot || busy}
          className="min-w-36"
        >
          <SelectValue>{snapshot?.userConfig.kind === "wsl" ? "WSL" : "本机"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="native">本机</SelectItem>
            {snapshot?.wslSupported ? <SelectItem value="wsl">WSL</SelectItem> : null}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : snapshot?.restartRequired ? (
        <Link
          to="/settings/$section"
          params={{ section: "runtime" }}
          className="text-xs underline underline-offset-4"
        >
          已保存，前往重启后台
        </Link>
      ) : snapshot?.source === "启动环境变量覆盖" ? (
        <p className="text-xs text-muted-foreground">运行位置由启动变量覆盖</p>
      ) : null}
    </div>
  )
}
