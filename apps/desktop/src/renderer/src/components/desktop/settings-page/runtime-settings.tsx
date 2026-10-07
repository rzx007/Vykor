import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"
import { Switch } from "@renderer/components/ui/switch"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Skeleton } from "@renderer/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@renderer/components/ui/alert-dialog"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  RuntimeEnvironmentConfig,
  RuntimeSettingsSnapshot,
} from "@shared/runtime-settings-types"
import { toast } from "@renderer/lib/toast"
import { SettingsGroup, SettingsRow, SettingsSelect, SettingsFoldout } from "./settings-group"
import { SettingsStatus } from "./settings-status"
import { errorMessage } from "./settings-error-message"

type Variable = { name: string; value: string; secret: boolean }
function variables(config: RuntimeEnvironmentConfig): Variable[] {
  return [
    ...Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value, secret: false })),
    ...(config.secretEnv ?? []).map((name) => ({ name, value: "", secret: true })),
  ]
}
function environmentLabel(config: RuntimeEnvironmentConfig) {
  return config.kind === "wsl" ? `WSL · ${config.distribution ?? "系统默认发行版"}` : "本机"
}
export function RuntimeSettings() {
  const projects = useDesktopSessionStore((state) => state.projects)
  const [scope, setScope] = useState("user")
  const cwd = projects.find((project) => project.id === scope)?.path
  const invalidScope = scope !== "user" && !cwd
  const [snapshot, setSnapshot] = useState<RuntimeSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<RuntimeEnvironmentConfig>({ kind: "native" })
  const [inherit, setInherit] = useState(false),
    [customShell, setCustomShell] = useState(false)
  const [rows, setRows] = useState<Variable[]>([]),
    [args, setArgs] = useState("")
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [pendingScope, setPendingScope] = useState<string | null>(null),
    [restartOpen, setRestartOpen] = useState(false)
  const [checks, setChecks] = useState<
    Awaited<ReturnType<typeof window.desktop.runtimeSettings.check>>
  >([])
  const generation = useRef(0),
    savedForm = useRef(""),
    locked = useRef(false)
  const form = JSON.stringify({ draft, inherit, rows, args, customShell })
  const dirty = snapshot !== null && form !== savedForm.current
  function apply(next: RuntimeSettingsSnapshot) {
    const own = cwd ? next.projectConfig : next.userConfig
    const config = own ?? { kind: next.effective.kind }
    const nextInherit = Boolean(cwd && !own),
      nextRows = variables(config),
      nextArgs = config.shell?.args.join("\n") ?? "",
      nextCustom = Boolean(config.shell)
    savedForm.current = JSON.stringify({
      draft: config,
      inherit: nextInherit,
      rows: nextRows,
      args: nextArgs,
      customShell: nextCustom,
    })
    setSnapshot(next)
    setDraft(config)
    setInherit(nextInherit)
    setRows(nextRows)
    setArgs(nextArgs)
    setCustomShell(nextCustom)
  }
  useEffect(() => {
    const current = ++generation.current
    setBusy(true)
    setSnapshot(null)
    setError(null)
    setChecks([])
    if (invalidScope) {
      setError("所选项目已移除，请选择其他设置范围。")
      setBusy(false)
      return () => {
        generation.current++
      }
    }
    void window.desktop.runtimeSettings
      .snapshot({ cwd })
      .then(
        (next) => {
          if (generation.current === current) apply(next)
        },
        (failure) => {
          if (generation.current === current) setError(errorMessage(failure))
        }
      )
      .finally(() => {
        if (generation.current === current) setBusy(false)
      })
    return () => {
      generation.current++
    }
  }, [cwd, invalidScope])
  async function run(operation: () => Promise<void>) {
    if (locked.current || busy) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  function config(): RuntimeEnvironmentConfig {
    const env: Record<string, string> = Object.create(null),
      secretEnv: string[] = [],
      names = new Set<string>()
    for (const row of rows) {
      const name = row.name.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name))
        throw new Error("环境变量名称无效或重复。")
      names.add(name)
      if (row.secret) secretEnv.push(name)
      else env[name] = row.value
    }
    if (customShell && !draft.shell?.executable.trim())
      throw new Error("请输入自定义 Shell 可执行文件，或关闭自定义设置。")
    return {
      ...draft,
      shell:
        customShell && draft.shell?.executable.trim()
          ? { executable: draft.shell.executable.trim(), args: args.split(/\r?\n/).filter(Boolean) }
          : undefined,
      env,
      secretEnv,
    }
  }
  async function save() {
    if (!snapshot || !dirty || invalidScope) return
    const expected = cwd ? snapshot.projectConfig : snapshot.userConfig
    const next = cwd && inherit ? null : config()
    const secrets: Record<string, string | null> = {}
    for (const row of rows)
      if (row.secret && row.value && next?.secretEnv?.includes(row.name.trim()))
        secrets[row.name.trim()] = row.value
    for (const name of expected?.secretEnv ?? [])
      if (!next?.secretEnv?.includes(name)) secrets[name] = null
    apply(
      await window.desktop.runtimeSettings.save({
        cwd,
        config: next,
        expected,
        secrets,
        expectedSecretRevision: snapshot.secretRevision,
      })
    )
    toast.success(cwd ? "已保存，下次任务生效。" : "已保存，按页面状态确认是否需要重启。")
  }
  function changeScope(next: string) {
    if (next === scope) return
    if (dirty) setPendingScope(next)
    else setScope(next)
  }
  const locationOptions = [
    ...(cwd ? [{ value: "inherit", label: "继承用户默认" }] : []),
    { value: "native", label: "本机" },
    ...(snapshot?.wslSupported ? [{ value: "wsl", label: "WSL" }] : []),
  ]
  return (
    <div className="flex flex-col gap-8" aria-busy={busy}>
      <SettingsRow
        title="设置范围"
        labelFor="runtime-scope"
        control={
          <SettingsSelect
            id="runtime-scope"
            label="设置范围"
            value={scope}
            options={[
              { value: "user", label: "用户默认" },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            disabled={busy}
            onChange={changeScope}
          />
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!snapshot && busy ? <Skeleton className="h-48 w-full" /> : null}
      {snapshot ? (
        <>
          <SettingsGroup title="当前生效状态" separated>
            <SettingsRow
              title="后台默认环境"
              description={environmentLabel(snapshot.activeDefault)}
              control={
                <SettingsStatus tone={snapshot.restartRequired ? "warning" : "neutral"}>
                  {snapshot.restartRequired
                    ? "待重启应用"
                    : snapshot.source === "启动环境变量覆盖"
                      ? "启动变量控制"
                      : "已采用"}
                </SettingsStatus>
              }
            />
            {cwd || snapshot.restartRequired || snapshot.source === "启动环境变量覆盖" ? (
              <SettingsRow
                title="后续任务环境"
                description={`${environmentLabel(snapshot.effective)} · ${snapshot.source}`}
                control={
                  <Link
                    to="/settings/$section"
                    params={{ section: "permissions" }}
                    className="text-xs underline underline-offset-4"
                  >
                    访问保护设置
                  </Link>
                }
              />
            ) : null}
            {snapshot.restartRequired ? (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <p className="text-xs text-muted-foreground">
                  用户默认已保存，重启后台后采用；现有任务保持原环境。
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || dirty}
                  onClick={() => setRestartOpen(true)}
                >
                  重启并应用
                </Button>
              </div>
            ) : null}
          </SettingsGroup>
          <SettingsGroup
            title="执行位置"
            separated
            description="修改后统一保存，不影响正在运行的任务。"
            action={
              cwd ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setChecks(
                        await window.desktop.runtimeSettings.check({
                          cwd,
                          config: inherit ? snapshot.effective : config(),
                        })
                      )
                    )
                  }
                >
                  检查此项目环境
                </Button>
              ) : undefined
            }
          >
            <SettingsRow
              title="运行位置"
              labelFor="runtime-kind"
              description={
                inherit
                  ? `当前继承：${environmentLabel(snapshot.effective)}`
                  : "智能体命令、脚本和工具的默认执行位置。"
              }
              control={
                <SettingsSelect
                  id="runtime-kind"
                  label="运行位置"
                  value={inherit ? "inherit" : draft.kind}
                  options={locationOptions}
                  disabled={busy}
                  onChange={(value) => {
                    setInherit(value === "inherit")
                    if (value === "native" || value === "wsl")
                      setDraft((current) => ({ ...current, kind: value }))
                  }}
                />
              }
            />
            {!inherit && draft.kind === "wsl" ? (
              <SettingsRow
                title="WSL 发行版"
                labelFor="runtime-distribution"
                description="使用 Windows 盘符项目目录，不支持 WSL UNC 路径。"
                control={
                  <SettingsSelect
                    id="runtime-distribution"
                    label="WSL 发行版"
                    value={draft.distribution ?? "default"}
                    options={[
                      { value: "default", label: "系统默认" },
                      ...snapshot.distributions.map((name) => ({ value: name, label: name })),
                    ]}
                    disabled={busy}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        distribution: value === "default" ? undefined : value,
                      }))
                    }
                  />
                }
              />
            ) : null}
          </SettingsGroup>
          {checks.length ? (
            <SettingsGroup title="项目环境检查" separated>
              {checks.map((check) => (
                <SettingsRow
                  key={check.name}
                  title={check.name}
                  description={check.detail}
                  control={
                    <SettingsStatus
                      tone={
                        check.status === "ok"
                          ? "success"
                          : check.status === "warning"
                            ? "warning"
                            : "error"
                      }
                    >
                      {check.status === "ok"
                        ? "可用"
                        : check.status === "warning"
                          ? "建议检查"
                          : "不可用"}
                    </SettingsStatus>
                  }
                />
              ))}
            </SettingsGroup>
          ) : null}
          <SettingsFoldout title={`高级选项 · ${rows.length} 个自定义变量`} id="runtime-advanced">
            {inherit ? (
              <p className="text-sm text-muted-foreground">
                此项目继承用户默认。选择本机或 WSL 后可配置项目专用 Shell 和变量。
              </p>
            ) : (
              <>
                <SettingsGroup title="命令 Shell" separated>
                  <SettingsRow
                    title="使用自定义命令 Shell"
                    description="仅用于智能体执行命令，不影响手动打开的终端。"
                    control={
                      <Switch
                        aria-label="使用自定义命令 Shell"
                        checked={customShell}
                        disabled={busy}
                        onCheckedChange={setCustomShell}
                      />
                    }
                  />
                  {customShell ? (
                    <>
                      <SettingsRow
                        title="Shell 可执行文件"
                        labelFor="runtime-shell"
                        control={
                          <Input
                            id="runtime-shell"
                            className="w-56"
                            value={draft.shell?.executable ?? ""}
                            placeholder="例如 pwsh.exe 或 /bin/bash"
                            disabled={busy}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                shell: {
                                  executable: event.target.value,
                                  args: current.shell?.args ?? [],
                                },
                              }))
                            }
                          />
                        }
                      />
                      <SettingsRow
                        title="命令 Shell 参数"
                        labelFor="runtime-shell-args"
                        description="自定义参数需包含 -c 或 -Command。"
                        control={
                          <Textarea
                            id="runtime-shell-args"
                            className="w-56"
                            value={args}
                            rows={2}
                            placeholder={"每行一个参数，留空使用默认值\n-c"}
                            disabled={busy}
                            onChange={(event) => setArgs(event.target.value)}
                          />
                        }
                      />
                    </>
                  ) : null}
                </SettingsGroup>
                <SettingsGroup
                  title="环境变量"
                  id="runtime-env-heading"
                  action={
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setRows((current) => [...current, { name: "", value: "", secret: false }])
                      }
                    >
                      添加变量
                    </Button>
                  }
                >
                  <p className="mb-4 text-xs text-muted-foreground">
                    下次启动进程生效，不修改系统变量。机密不回显、不导出，留空保留。
                  </p>
                  {rows.length ? (
                    <div className="flex flex-col gap-4">
                      {rows.map((row, index) => (
                        <div key={index} className="settings-variable-row">
                          <label
                            className="flex flex-col gap-2 text-xs"
                            htmlFor={`runtime-env-name-${index}`}
                          >
                            变量名称
                            <Input
                              id={`runtime-env-name-${index}`}
                              placeholder="例如 NODE_ENV"
                              value={row.name}
                              disabled={busy}
                              onChange={(event) =>
                                setRows((current) =>
                                  current.map((item, position) =>
                                    position === index
                                      ? {
                                          ...item,
                                          name: event.target.value,
                                          secret:
                                            item.secret ||
                                            /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(
                                              event.target.value
                                            ),
                                        }
                                      : item
                                  )
                                )
                              }
                            />
                          </label>
                          <label
                            className="flex flex-col gap-2 text-xs"
                            htmlFor={`runtime-env-value-${index}`}
                          >
                            变量值{row.secret ? "（机密）" : ""}
                            <Input
                              id={`runtime-env-value-${index}`}
                              placeholder={row.secret ? "留空保留已保存值" : "例如 development"}
                              type={row.secret ? "password" : "text"}
                              autoComplete="off"
                              value={row.value}
                              disabled={busy}
                              onChange={(event) =>
                                setRows((current) =>
                                  current.map((item, position) =>
                                    position === index
                                      ? { ...item, value: event.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </label>
                          <div className="flex items-center gap-3 pb-1">
                            <label htmlFor={`runtime-env-secret-${index}`} className="text-xs">
                              机密
                            </label>
                            <Switch
                              id={`runtime-env-secret-${index}`}
                              checked={row.secret}
                              disabled={busy}
                              onCheckedChange={(secret) =>
                                setRows((current) =>
                                  current.map((item, position) =>
                                    position === index ? { ...item, secret } : item
                                  )
                                )
                              }
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                setRows((current) =>
                                  current.filter((_, position) => position !== index)
                                )
                              }
                            >
                              删除
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="py-3 text-sm text-muted-foreground">暂无自定义变量。</p>
                  )}
                </SettingsGroup>
              </>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">继承的进程变量名称</summary>
              <p className="mt-2 break-all">
                {snapshot.inheritedVariableNames.join("、") || "无记录"}
              </p>
            </details>
          </SettingsFoldout>
          {dirty ? (
            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-4">
              <p className="text-xs text-muted-foreground">有尚未保存的修改</p>
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => void run(save)}>
                  保存环境设置
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => apply(snapshot)}>
                  取消修改
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : !busy ? (
        <Button
          variant="outline"
          className="self-start"
          onClick={() =>
            void run(async () => apply(await window.desktop.runtimeSettings.snapshot({ cwd })))
          }
        >
          重新读取
        </Button>
      ) : null}
      <AlertDialog
        open={pendingScope !== null}
        onOpenChange={(open) => {
          if (!open) setPendingScope(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>
              切换设置范围不会保存当前草稿。取消可继续编辑。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const next = pendingScope
                setPendingScope(null)
                if (next) setScope(next)
              }}
            >
              放弃修改并切换
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重启后台并应用环境？</AlertDialogTitle>
            <AlertDialogDescription>
              任务或终端未结束时不可重启。重启不会续跑旧任务或恢复终端。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.desktop.runtimeSettings.restart()
                  apply(await window.desktop.runtimeSettings.snapshot({ cwd }))
                  setRestartOpen(false)
                  toast.success("后台已重启，默认环境已更新。")
                })
              }
            >
              确认重启
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
