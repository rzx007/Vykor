import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select"
import { Switch } from "@renderer/components/ui/switch"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { RuntimeEnvironmentConfig, RuntimeSettingsSnapshot } from "@shared/runtime-settings-types"
import { errorMessage } from "./settings-error-message"

type Variable = { name: string; value: string; secret: boolean }
function variables(config: RuntimeEnvironmentConfig): Variable[] {
  return [...Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value, secret: false })),
    ...(config.secretEnv ?? []).map(name => ({ name, value: "", secret: true }))]
}

export function RuntimeSettings() {
  const projects = useDesktopSessionStore(state => state.projects)
  const [scope, setScope] = useState("user")
  const cwd = projects.find(project => project.id === scope)?.path
  const [snapshot, setSnapshot] = useState<RuntimeSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<RuntimeEnvironmentConfig>({ kind: "native" })
  const [inherit, setInherit] = useState(false)
  const [rows, setRows] = useState<Variable[]>([])
  const [args, setArgs] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof window.desktop.runtimeSettings.check>>>([])
  const generation = useRef(0)
  function apply(next: RuntimeSettingsSnapshot) {
    const own = cwd ? next.projectConfig : next.userConfig
    const config = own ?? { kind: next.effective.kind }
    setSnapshot(next); setDraft(config); setInherit(Boolean(cwd && !own)); setRows(variables(config)); setArgs(config.shell?.args.join("\n") ?? "")
  }
  useEffect(() => {
    const current = ++generation.current
    setBusy(true); setSnapshot(null); setError(null); setNotice(""); setChecks([])
    void window.desktop.runtimeSettings.snapshot({ cwd }).then(next => { if (generation.current === current) apply(next) })
      .catch(failure => { if (generation.current === current) setError(errorMessage(failure)) })
      .finally(() => { if (generation.current === current) setBusy(false) })
    return () => { generation.current++ }
  }, [cwd])
  async function run(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(null); setNotice("")
    try { await operation() } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
  }
  function config(): RuntimeEnvironmentConfig {
    const env: Record<string, string> = {}, secretEnv: string[] = [], names = new Set<string>()
    for (const row of rows) {
      const name = row.name.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error("环境变量名称无效或重复。")
      names.add(name); if (row.secret) secretEnv.push(name); else env[name] = row.value
    }
    return { ...draft, ...(draft.shell?.executable.trim() ? { shell: { executable: draft.shell.executable.trim(), args: args.split(/\r?\n/).filter(Boolean) } } : { shell: undefined }), env, secretEnv }
  }
  async function save() {
    if (!snapshot) return
    const expected = cwd ? snapshot.projectConfig : snapshot.userConfig
    const next = cwd && inherit ? null : config()
    const secrets: Record<string, string | null> = {}
    for (const row of rows) if (row.secret && row.value) secrets[row.name.trim()] = row.value
    for (const name of expected?.secretEnv ?? []) if (!next?.secretEnv?.includes(name)) secrets[name] = null
    apply(await window.desktop.runtimeSettings.save({ cwd, config: next, expected, secrets }))
    setNotice(cwd ? "项目环境已保存，后续任务采用；当前任务和终端保持原环境。" : "用户默认已保存，重启后台服务后采用。")
  }
  const scopes = [{ value: "user", label: "用户默认" }, ...projects.map(project => ({ value: project.id, label: project.name }))]
  const modes = [{ value: "native", label: "本机" }, ...(snapshot?.wslSupported ? [{ value: "wsl", label: "WSL" }] : [])]
  return <div className="flex flex-col gap-6" aria-busy={busy}>
    <Field><FieldLabel htmlFor="runtime-scope">设置范围</FieldLabel><Select items={scopes} value={scope} onValueChange={value => { if (value) setScope(value) }}>
      <SelectTrigger id="runtime-scope" disabled={busy}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{scopes.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    {!snapshot && busy ? <Skeleton className="h-48 w-full" /> : null}
    {snapshot ? <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
        <dt>当前服务默认</dt><dd>{snapshot.activeDefault.kind === "wsl" ? `WSL · ${snapshot.activeDefault.distribution ?? "系统默认发行版"}` : "本机"}</dd>
        <dt>所选项目的后续任务</dt><dd>{snapshot.effective.kind === "wsl" ? "WSL" : "本机"} · {snapshot.source}</dd>
        <dt>已保存用户默认</dt><dd>{snapshot.userConfig.kind === "wsl" ? "WSL" : "本机"}{snapshot.restartRequired ? " · 等待后台重启" : " · 已采用"}</dd>
      </dl>
      <FieldGroup>
        {cwd ? <Field orientation="horizontal"><FieldContent><FieldLabel htmlFor="runtime-inherit">继承用户默认</FieldLabel><FieldDescription>开启并保存会移除该项目的环境覆盖；已有任务不迁移。</FieldDescription></FieldContent><Switch id="runtime-inherit" checked={inherit} disabled={busy} onCheckedChange={setInherit} /></Field> : null}
        <Field><FieldLabel htmlFor="runtime-kind">运行位置</FieldLabel><Select items={modes} value={draft.kind} onValueChange={value => { if (value === "native" || value === "wsl") setDraft(current => ({ ...current, kind: value })) }}>
          <SelectTrigger id="runtime-kind" disabled={busy || inherit}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{modes.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        {draft.kind === "wsl" ? <Field><FieldLabel htmlFor="runtime-distribution">WSL 发行版</FieldLabel><Select items={[{ value: "default", label: "系统默认" }, ...snapshot.distributions.map(name => ({ value: name, label: name }))]} value={draft.distribution ?? "default"} onValueChange={value => setDraft(current => ({ ...current, distribution: value === "default" ? undefined : value ?? undefined }))}>
          <SelectTrigger id="runtime-distribution" disabled={busy || inherit}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="default">系统默认</SelectItem>{snapshot.distributions.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>项目需使用 Windows 盘符目录；WSL Linux 文件系统项目目前不可用。</FieldDescription></Field> : null}
        <Field><FieldLabel htmlFor="runtime-shell">智能体命令 Shell</FieldLabel><Input id="runtime-shell" disabled={busy || inherit} value={draft.shell?.executable ?? ""} placeholder="留空使用系统命令 Shell" onChange={event => setDraft(current => ({ ...current, shell: { executable: event.target.value, args: current.shell?.args ?? [] } }))} /><FieldDescription>这里控制智能体命令；用户集成终端的 Shell 在终端页单独设置。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="runtime-shell-args">命令 Shell 参数</FieldLabel><Textarea id="runtime-shell-args" disabled={busy || inherit} value={args} rows={2} onChange={event => setArgs(event.target.value)} /><FieldDescription>每行一个参数。留空沿用 Shell 的执行参数；自定义参数需包含接收命令的 -c 或 -Command 等参数。</FieldDescription></Field>
      </FieldGroup>
      <section aria-labelledby="runtime-env-heading" className="flex flex-col gap-3"><h2 id="runtime-env-heading" className="text-base font-semibold">环境变量</h2><p className="text-sm text-muted-foreground">只进入对应任务的新进程，不修改系统全局变量。机密值不会显示或导出，已配置机密留空会保留原值。</p>
        {rows.map((row, index) => <FieldGroup key={index} className="gap-3"><Field><FieldLabel htmlFor={`runtime-env-name-${index}`}>变量名称</FieldLabel><Input id={`runtime-env-name-${index}`} disabled={busy || inherit} value={row.name} onChange={event => setRows(current => current.map((item, position) => position === index ? { ...item, name: event.target.value, secret: item.secret || /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(event.target.value) } : item))} /></Field><Field><FieldLabel htmlFor={`runtime-env-value-${index}`}>变量值{row.secret ? "（机密）" : ""}</FieldLabel><Input id={`runtime-env-value-${index}`} type={row.secret ? "password" : "text"} autoComplete="off" disabled={busy || inherit} value={row.value} onChange={event => setRows(current => current.map((item, position) => position === index ? { ...item, value: event.target.value } : item))} /></Field><Field orientation="horizontal"><FieldLabel htmlFor={`runtime-env-secret-${index}`}>作为机密保存</FieldLabel><Switch id={`runtime-env-secret-${index}`} disabled={busy || inherit} checked={row.secret} onCheckedChange={secret => setRows(current => current.map((item, position) => position === index ? { ...item, secret } : item))} /><Button variant="ghost" disabled={busy || inherit} onClick={() => setRows(current => current.filter((_, position) => position !== index))}>删除变量</Button></Field></FieldGroup>)}
        <Button variant="outline" disabled={busy || inherit} onClick={() => setRows(current => [...current, { name: "", value: "", secret: false }])}>添加变量</Button>
        <details className="text-sm text-muted-foreground"><summary>继承的进程变量名称</summary><p className="mt-2 break-all">{snapshot.inheritedVariableNames.join("、")}</p></details>
      </section>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void run(save)}>保存环境设置</Button><Button variant="ghost" disabled={busy} onClick={() => apply(snapshot)}>取消修改</Button><Button variant="outline" disabled={busy || !cwd} onClick={() => void run(async () => setChecks(await window.desktop.runtimeSettings.check({ cwd: cwd!, config: inherit ? snapshot.effective : config() })))}>检查所选项目环境</Button></div>
      {checks.length ? <ul className="flex flex-col gap-2 text-sm">{checks.map(check => <li key={check.name}>{check.name} · {check.status === "ok" ? "可用" : check.status === "warning" ? "提示" : "失败"} · {check.detail}</li>)}</ul> : null}
      {snapshot.restartRequired ? <div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={busy} onClick={() => void run(async () => { await window.desktop.runtimeSettings.restart(); apply(await window.desktop.runtimeSettings.snapshot({ cwd })); setNotice("后台服务已重启，默认环境已重新读取。") })}>任务结束后重启后台</Button><p className="text-sm text-muted-foreground">有运行或排队任务、终端时会阻止重启。</p></div> : null}
      <Link to="/settings/$section" params={{ section: "permissions" }} className="text-sm underline underline-offset-4">在权限页查看文件和网络访问边界</Link>
    </> : <Button variant="outline" disabled={busy} onClick={() => void run(async () => apply(await window.desktop.runtimeSettings.snapshot({ cwd })))}>重新读取</Button>}
  </div>
}
