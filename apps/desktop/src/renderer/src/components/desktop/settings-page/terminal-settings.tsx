import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"
import { Switch } from "@renderer/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@renderer/components/ui/dialog"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { CODE_FONT_OPTIONS } from "@renderer/components/appearance/appearance-fonts"
import { selectActiveWorkspaceProject, useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { TerminalSettings as TerminalPreferences, TerminalSettingsSnapshot, TerminalEnvironmentVariable } from "@shared/terminal-settings-types"
import type { DesktopDetectedTerminalShell } from "@shared/terminal-types"
import { TerminalTool, type TerminalPanelCommand } from "../tools/terminal/terminal-tool"
import { errorMessage } from "./settings-error-message"

export function TerminalSettings() {
  const [snapshot, setSnapshot] = useState<TerminalSettingsSnapshot | null>(null)
  const [shells, setShells] = useState<DesktopDetectedTerminalShell[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const [custom, setCustom] = useState(false)
  const [executable, setExecutable] = useState("")
  const [argumentsText, setArgumentsText] = useState("[]")
  const [wslShell, setWslShell] = useState("")
  const [wslArguments, setWslArguments] = useState("[]")
  const [environment, setEnvironment] = useState<TerminalEnvironmentVariable[]>([])
  const [testing, setTesting] = useState(false)
  const [testTerminal, setTestTerminal] = useState<string | null>(null)
  const [testCommand, setTestCommand] = useState<TerminalPanelCommand | null>(null)
  const testIds = useRef(new Set<string>())
  const locked = useRef(false)
  const selectedProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const { preferences: appearance, fontAvailability } = useAppearance()

  function acceptStartup(value: TerminalSettingsSnapshot) {
    const settings = value.settings
    setSnapshot(value)
    setCustom(Boolean(settings.customShell))
    setExecutable(settings.customShell?.executable ?? "")
    setArgumentsText(JSON.stringify(settings.customShell?.args ?? []))
    setWslShell(settings.wslShell)
    setWslArguments(JSON.stringify(settings.wslShellArgs))
    setEnvironment(settings.environment)
  }

  async function load() {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(null)
    try {
      const [next, detected] = await Promise.all([window.desktop.terminalSettings.snapshot(), window.desktop.terminal.listShells()])
      acceptStartup(next); setShells(detected)
    } catch (failure) { setError(errorMessage(failure)) }
    finally { locked.current = false; setBusy(false) }
  }

  useEffect(() => { void load(); return () => { for (const id of testIds.current) void window.desktop.terminal.kill(id).catch(() => {}) } }, [])

  async function save(settings: TerminalPreferences, shellId = snapshot?.defaultTerminalShellId ?? null, startup = false) {
    if (!snapshot || locked.current) return undefined
    locked.current = true; setBusy(true); setError(null); setFeedback("")
    try {
      const next = await window.desktop.terminalSettings.update({ settings, defaultTerminalShellId: shellId, expectedRevision: snapshot.revision })
      setSnapshot(next)
      if (startup) acceptStartup(next)
      setFeedback(startup || shellId !== snapshot.defaultTerminalShellId ? "启动设置已保存，新终端生效。已有终端继续运行。" : "已保存，终端显示和交互立即生效。")
      return next
    } catch (failure) { setError(errorMessage(failure)) }
    finally { locked.current = false; setBusy(false) }
    return undefined
  }

  function update<K extends keyof TerminalPreferences>(key: K, value: TerminalPreferences[K]) {
    if (snapshot) return save({ ...snapshot.settings, [key]: value })
    return undefined
  }

  function saveStartup() {
    if (!snapshot) return
    try {
      const args: unknown = JSON.parse(argumentsText)
      const wslArgs: unknown = JSON.parse(wslArguments)
      if (!Array.isArray(args) || !Array.isArray(wslArgs) || !args.every((entry) => typeof entry === "string") || !wslArgs.every((entry) => typeof entry === "string")) throw new Error("启动参数需为数组，每个参数单独写在引号中。")
      void save({ ...snapshot.settings, customShell: custom ? { executable, args } : null, wslShell, wslShellArgs: wslArgs, environment }, undefined, true)
    } catch (failure) { setError(errorMessage(failure)) }
  }

  async function closeTest() {
    setTesting(false); setTestTerminal(null); setTestCommand(null)
    const ids = [...testIds.current]; testIds.current.clear()
    for (const id of ids) {
      try { await window.desktop.terminal.kill(id) }
      catch (failure) { setError(errorMessage(failure)) }
    }
  }

  if (!snapshot) return <div className="mx-auto max-w-3xl px-6 py-8"><h1 className="text-xl font-semibold">终端</h1>{error ? <p role="alert" className="mt-4 text-sm text-destructive">{error}</p> : <Skeleton className="mt-5 h-40" />}<Button variant="ghost" className="mt-3" disabled={busy} onClick={() => void load()}>重新读取</Button></div>
  const value = snapshot.settings
  return <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
    <div><h1 className="text-xl font-semibold">终端</h1><p className="mt-2 text-sm text-muted-foreground">当前设备的用户集成终端。智能体命令的环境与 Shell 在运行环境页设置。</p></div>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="ghost" disabled={busy} onClick={() => void load()}>重新读取与检测</Button>
      <Button disabled={busy || !selectedProject?.available} onClick={() => { setTesting(true); setTestCommand({ id: Date.now(), type: "create" }) }}>打开测试终端</Button>
      {!selectedProject?.available && <span className="text-xs text-muted-foreground">请先选择可用项目。</span>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {feedback && <p role="status" className="text-xs text-muted-foreground">{feedback}</p>}
    {snapshot.shellError && <p role="alert" className="text-sm text-destructive">{snapshot.shellError}</p>}

    <section className="space-y-4" aria-labelledby="terminal-startup-title">
      <h2 id="terminal-startup-title" className="text-base font-semibold">启动设置</h2>
      <p className="text-xs text-muted-foreground">新终端生效。目录跟随会话的实际工作目录；没有会话时使用所选项目。测试终端使用已保存设置，不执行额外脚本。</p>
      <Setting label="本机默认 Shell" description={value.customShell ? "已保存的自定义 Shell 优先使用。" : "默认系统 Shell；失效选择会阻止创建并提示修复。"}>
        <Select value={snapshot.defaultTerminalShellId ?? "system"} onValueChange={(id) => { if (typeof id === "string") void save(snapshot.settings, id === "system" ? null : id) }}>
          <SelectTrigger aria-label="本机默认 Shell" disabled={busy}><SelectValue>{shells.find((shell) => shell.id === snapshot.defaultTerminalShellId)?.label ?? (snapshot.defaultTerminalShellId ? `失效：${snapshot.defaultTerminalShellId}` : "系统默认")}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="system">系统默认</SelectItem>{shells.map((shell) => <SelectItem key={shell.id} value={shell.id}>{shell.label}</SelectItem>)}</SelectContent>
        </Select>
      </Setting>
      <Setting label="使用自定义本机 Shell" description="通过下方保存启动设置；关闭后沿用本机默认 Shell。"><Switch aria-label="使用自定义本机 Shell" checked={custom} onCheckedChange={setCustom} disabled={busy} /></Setting>
      {custom && <div className="space-y-3">
        <label className="block space-y-2 text-sm"><span>自定义 Shell 可执行文件</span><div className="flex gap-2"><Input value={executable} onChange={(event) => setExecutable(event.target.value)} disabled={busy} /><Button variant="ghost" disabled={busy} onClick={() => { void window.desktop.terminalSettings.chooseShell().then((path) => { if (path) setExecutable(path) }).catch((failure) => setError(errorMessage(failure))) }}>选择文件</Button></div></label>
        <label className="block space-y-2 text-sm"><span>分开的启动参数</span><Textarea value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} disabled={busy} /><span className="block text-xs text-muted-foreground">例如 ["--login", "--profile", "two words"]，每个引号内的内容是一个完整参数；不会拼成命令字符串。</span></label>
      </div>}
      <label className="block space-y-2 text-sm"><span>WSL Shell（留空跟随运行环境的发行版与 Shell）</span><Input value={wslShell} placeholder="/bin/bash" onChange={(event) => setWslShell(event.target.value)} disabled={busy} /></label>
      {wslShell && <label className="block space-y-2 text-sm"><span>WSL 分开的启动参数</span><Textarea value={wslArguments} onChange={(event) => setWslArguments(event.target.value)} disabled={busy} /></label>}
      <div className="space-y-3"><h3 className="text-sm font-medium">终端专用环境变量</h3><p className="text-xs text-muted-foreground">仅用于新用户终端，不改变系统或智能体变量。机密值不回显，留空保留已保存值；删除行会移除该覆盖。</p>
        {environment.map((entry, index) => <div key={index} className="flex flex-wrap items-center gap-2">
          <Input aria-label={`变量 ${index + 1} 名称`} className="min-w-32 flex-1" value={entry.name} disabled={busy} onChange={(event) => setEnvironment(environment.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
          <Input aria-label={`变量 ${index + 1} 值`} type={entry.secret ? "password" : "text"} className="min-w-36 flex-1" value={entry.value} placeholder={entry.hasValue ? "已保存；留空保留" : "值"} disabled={busy} onChange={(event) => setEnvironment(environment.map((item, i) => i === index ? { ...item, value: event.target.value, hasValue: false } : item))} />
          <label className="flex items-center gap-2 text-xs"><Switch checked={entry.secret} aria-label={`变量 ${index + 1} 机密值`} disabled={busy || (!entry.secret && !snapshot.secretStorageAvailable)} onCheckedChange={(secret) => setEnvironment(environment.map((item, i) => i === index ? { ...item, secret } : item))} />机密</label>
          <Button variant="ghost" disabled={busy} onClick={() => setEnvironment(environment.filter((_, i) => i !== index))}>移除</Button>
        </div>)}
        {!snapshot.secretStorageAvailable && <p className="text-xs text-muted-foreground">系统机密存储不可用，机密变量无法新增或保存。</p>}
        <Button variant="ghost" disabled={busy} onClick={() => setEnvironment([...environment, { name: "", value: "", secret: false }])}>添加变量</Button>
      </div>
      <Button disabled={busy} onClick={saveStartup}>{busy ? "保存中…" : "保存启动设置"}</Button>
    </section>

    <section className="space-y-4 border-t pt-6" aria-labelledby="terminal-display-title"><h2 id="terminal-display-title" className="text-base font-semibold">显示与交互</h2><p className="text-xs text-muted-foreground">自动保存，立即更新已有终端显示；不会重新启动进程。主题跟随应用。</p>
      <Setting label="终端字体" description={value.fontMode === "code" ? `跟随外观代码字体：${CODE_FONT_OPTIONS.find((font) => font.id === appearance.codeFont)?.label ?? appearance.codeFont}` : "独立字体只影响终端；缺字时使用应用等宽字体回退。"}>
        <Select value={value.fontMode === "code" ? "code" : value.fontFamily} onValueChange={(family) => { if (typeof family === "string") void save({ ...value, fontMode: family === "code" ? "code" : "independent", fontFamily: family === "code" ? value.fontFamily : family }) }}>
          <SelectTrigger disabled={busy} aria-label="终端字体"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="code">跟随代码字体</SelectItem>{CODE_FONT_OPTIONS.map((font) => <SelectItem key={font.id} value={font.id === "geist-mono" ? "Geist Mono Variable" : font.label} disabled={fontAvailability[font.id] === false}>{font.label}{fontAvailability[font.id] === false ? "（未安装）" : ""}</SelectItem>)}{!["Geist Mono Variable", "Cascadia Code", "Cascadia Mono", "Consolas"].includes(value.fontFamily) && <SelectItem value={value.fontFamily}>{value.fontFamily}</SelectItem>}</SelectContent>
        </Select>
      </Setting>
      <Setting label="字号" description="10–24 px，默认 13 px。"><Input aria-label="终端字号" type="number" min={10} max={24} defaultValue={value.fontSize} key={`font-${value.fontSize}`} disabled={busy} onBlur={(event) => { const input = event.currentTarget; if (Number(input.value) !== value.fontSize) void update("fontSize", Number(input.value))?.then((saved) => { if (!saved) input.value = String(value.fontSize) }) }} /></Setting>
      <Setting label="滚动历史行数" description="1,000–100,000 行；越大越占内存。降低时旧历史可能被裁剪，不等同于持久日志。"><Input aria-label="终端滚动历史行数" type="number" min={1000} max={100000} defaultValue={value.scrollback} key={`scroll-${value.scrollback}`} disabled={busy} onBlur={(event) => { const input = event.currentTarget; if (Number(input.value) !== value.scrollback) void update("scrollback", Number(input.value))?.then((saved) => { if (!saved) input.value = String(value.scrollback) }) }} /></Setting>
      <Setting label="光标形状"><Select value={value.cursorStyle} onValueChange={(style) => { if (style === "block" || style === "bar" || style === "underline") update("cursorStyle", style) }}><SelectTrigger disabled={busy} aria-label="光标形状"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="block">块</SelectItem><SelectItem value="bar">竖线</SelectItem><SelectItem value="underline">下划线</SelectItem></SelectContent></Select></Setting>
      <Setting label="光标闪烁" description="开启减少动态效果时会自动停止闪烁。"><Switch checked={value.cursorBlink} disabled={busy} aria-label="光标闪烁" onCheckedChange={(enabled) => update("cursorBlink", enabled)} /></Setting>
      <Setting label="多行粘贴确认" description="包含换行时，先显示行数和预览；取消不向终端发送任何内容。"><Switch checked={value.confirmMultilinePaste} disabled={busy} aria-label="多行粘贴确认" onCheckedChange={(enabled) => update("confirmMultilinePaste", enabled)} /></Setting>
      <Link to="/settings/$section" params={{ section: "keyboard" }} className="text-sm underline underline-offset-4">管理终端与应用快捷键</Link>
    </section>

    <Dialog open={testing} onOpenChange={(open) => { if (!open) void closeTest() }}><DialogContent className="h-[70vh] max-w-4xl flex flex-col"><DialogHeader><DialogTitle>测试终端</DialogTitle><DialogDescription>使用已保存设置和当前会话或项目目录。关闭此窗口会关闭本次测试终端。</DialogDescription></DialogHeader><div className="relative min-h-0 flex-1"><TerminalTool active={testing} activeTerminalId={testTerminal} openRequest={null} command={testCommand} onSessionUpsert={(record, activate) => { testIds.current.add(record.id); if (activate) setTestTerminal(record.id) }} onSessionRemove={(id) => { testIds.current.delete(id); setTestTerminal(null) }} onSessionsHydrate={() => {}} onActiveTerminalChange={setTestTerminal} onCommandSettled={() => setTestCommand(null)} /></div></DialogContent></Dialog>
  </div>
}

function Setting({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-40 flex-1"><p className="text-sm font-medium">{label}</p>{description && <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{description}</p>}</div><div className="w-48 max-w-full">{children}</div></div>
}
