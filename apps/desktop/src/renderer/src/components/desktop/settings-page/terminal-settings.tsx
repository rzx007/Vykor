import { SettingsGroup, SettingsRow } from "./settings-group"
import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"
import { Switch } from "@renderer/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { CODE_FONT_OPTIONS } from "@renderer/components/appearance/appearance-fonts"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type {
  TerminalSettings as TerminalPreferences,
  TerminalSettingsSnapshot,
  TerminalEnvironmentVariable,
} from "@shared/terminal-settings-types"
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
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      const [next, detected] = await Promise.all([
        window.desktop.terminalSettings.snapshot(),
        window.desktop.terminal.listShells(),
      ])
      acceptStartup(next)
      setShells(detected)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    return () => {
      for (const id of testIds.current) void window.desktop.terminal.kill(id).catch(() => {})
    }
  }, [])

  async function save(
    settings: TerminalPreferences,
    shellId = snapshot?.defaultTerminalShellId ?? null,
    startup = false
  ) {
    if (!snapshot || locked.current) return undefined
    locked.current = true
    setBusy(true)
    setError(null)
    setFeedback("")
    try {
      const next = await window.desktop.terminalSettings.update({
        settings,
        defaultTerminalShellId: shellId,
        expectedRevision: snapshot.revision,
      })
      setSnapshot(next)
      if (startup) acceptStartup(next)
      setFeedback(
        startup || shellId !== snapshot.defaultTerminalShellId
          ? "已保存，新终端生效。"
          : "已保存，立即生效。"
      )
      return next
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      locked.current = false
      setBusy(false)
    }
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
      if (
        !Array.isArray(args) ||
        !Array.isArray(wslArgs) ||
        !args.every((entry) => typeof entry === "string") ||
        !wslArgs.every((entry) => typeof entry === "string")
      )
        throw new Error("启动参数需为数组，每个参数单独写在引号中。")
      void save(
        {
          ...snapshot.settings,
          customShell: custom ? { executable, args } : null,
          wslShell,
          wslShellArgs: wslArgs,
          environment,
        },
        undefined,
        true
      )
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  async function closeTest() {
    setTesting(false)
    setTestTerminal(null)
    setTestCommand(null)
    const ids = [...testIds.current]
    testIds.current.clear()
    for (const id of ids) {
      try {
        await window.desktop.terminal.kill(id)
      } catch (failure) {
        setError(errorMessage(failure))
      }
    }
  }

  if (!snapshot)
    return (
      <div className="settings-content-column">
        <h1 className="text-xl font-semibold">终端</h1>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <Skeleton className="mt-5 h-40" />
        )}
        <Button variant="ghost" className="mt-3" disabled={busy} onClick={() => void load()}>
          重新读取
        </Button>
      </div>
    )
  const value = snapshot.settings
  return (
    <div className="settings-content-column">
      <div>
        <h1 className="text-xl font-semibold">终端</h1>
        <p className="mt-2 text-sm text-muted-foreground">智能体命令的 Shell 在运行环境页设置。</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => void load()}>
          重新读取与检测
        </Button>
        <Button
          disabled={busy || !selectedProject?.available}
          onClick={() => {
            setTesting(true)
            setTestCommand({ id: Date.now(), type: "create" })
          }}
        >
          打开测试终端
        </Button>
        {!selectedProject?.available && (
          <span className="text-xs text-muted-foreground">请先选择可用项目。</span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {feedback && (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      )}
      {snapshot.shellError && (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.shellError}
        </p>
      )}

      <SettingsGroup
        title="启动设置"
        separated
        id="terminal-startup-title"
        description="新终端生效，目录跟随当前会话或项目。"
      >
        <Setting
          label="本机默认 Shell"
          description={
            value.customShell
              ? "已保存的自定义 Shell 优先使用。"
              : "默认系统 Shell；所选 Shell 失效时无法启动。"
          }
        >
          <Select
            value={snapshot.defaultTerminalShellId ?? "system"}
            onValueChange={(id) => {
              if (typeof id === "string") void save(snapshot.settings, id === "system" ? null : id)
            }}
          >
            <SelectTrigger
              aria-label="本机默认 Shell"
              disabled={busy}
              className="max-w-64 min-w-44"
            >
              <SelectValue>
                {shells.find((shell) => shell.id === snapshot.defaultTerminalShellId)?.label ??
                  (snapshot.defaultTerminalShellId
                    ? `失效：${snapshot.defaultTerminalShellId}`
                    : "系统默认")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="system">系统默认</SelectItem>
                {shells.map((shell) => (
                  <SelectItem key={shell.id} value={shell.id}>
                    {shell.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Setting>
        <Setting label="使用自定义本机 Shell" description="关闭后使用本机默认 Shell。">
          <Switch
            aria-label="使用自定义本机 Shell"
            checked={custom}
            onCheckedChange={setCustom}
            disabled={busy}
          />
        </Setting>
        {custom && (
          <div className="flex flex-col gap-3 py-4">
            <label className="settings-form-row text-sm">
              <span>Shell 可执行文件</span>
              <div className="flex gap-2">
                <Input
                  placeholder="例如 pwsh.exe 或完整路径"
                  value={executable}
                  onChange={(event) => setExecutable(event.target.value)}
                  disabled={busy}
                />
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void window.desktop.terminalSettings
                      .chooseShell()
                      .then((path) => {
                        if (path) setExecutable(path)
                      })
                      .catch((failure) => setError(errorMessage(failure)))
                  }}
                >
                  选择文件
                </Button>
              </div>
            </label>
            <label className="settings-form-row text-sm">
              <span>启动参数</span>
              <Textarea
                placeholder={'["--login"]'}
                value={argumentsText}
                onChange={(event) => setArgumentsText(event.target.value)}
                disabled={busy}
              />
            </label>
          </div>
        )}
        <SettingsRow
          title="WSL Shell"
          labelFor="terminal-wsl-shell"
          control={
            <Input
              id="terminal-wsl-shell"
              className="w-64 max-w-full"
              value={wslShell}
              placeholder="留空跟随运行环境，如 /bin/bash"
              onChange={(event) => setWslShell(event.target.value)}
              disabled={busy}
            />
          }
        />
        {wslShell && (
          <label className="settings-form-row text-sm">
            <span>WSL 分开的启动参数</span>
            <Textarea
              placeholder={'["-i"]'}
              value={wslArguments}
              onChange={(event) => setWslArguments(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">终端专用环境变量</h3>
          <p className="text-xs text-muted-foreground">
            仅用于新终端。机密不回显，留空保留；删除后移除覆盖。
          </p>
          {environment.map((entry, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`变量 ${index + 1} 名称`}
                className="min-w-32 flex-1"
                placeholder="变量名称，如 NODE_ENV"
                value={entry.name}
                disabled={busy}
                onChange={(event) =>
                  setEnvironment(
                    environment.map((item, i) =>
                      i === index ? { ...item, name: event.target.value } : item
                    )
                  )
                }
              />
              <Input
                aria-label={`变量 ${index + 1} 值`}
                type={entry.secret ? "password" : "text"}
                className="min-w-36 flex-1"
                value={entry.value}
                placeholder={entry.hasValue ? "已保存；留空保留" : "值"}
                disabled={busy}
                onChange={(event) =>
                  setEnvironment(
                    environment.map((item, i) =>
                      i === index ? { ...item, value: event.target.value, hasValue: false } : item
                    )
                  )
                }
              />
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={entry.secret}
                  aria-label={`变量 ${index + 1} 机密值`}
                  disabled={busy || (!entry.secret && !snapshot.secretStorageAvailable)}
                  onCheckedChange={(secret) =>
                    setEnvironment(
                      environment.map((item, i) => (i === index ? { ...item, secret } : item))
                    )
                  }
                />
                机密
              </label>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setEnvironment(environment.filter((_, i) => i !== index))}
              >
                移除
              </Button>
            </div>
          ))}
          {!snapshot.secretStorageAvailable && (
            <p className="text-xs text-muted-foreground">
              系统机密存储不可用，机密变量无法新增或保存。
            </p>
          )}
          <Button
            variant="ghost"
            className="self-start"
            disabled={busy}
            onClick={() => setEnvironment([...environment, { name: "", value: "", secret: false }])}
          >
            添加变量
          </Button>
        </div>
        <div className="flex justify-end py-4">
          <Button disabled={busy} onClick={saveStartup}>
            {busy ? "保存中…" : "保存启动设置"}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="显示与交互"
        separated
        id="terminal-display-title"
        description="自动保存并立即生效，主题跟随应用。"
      >
        <Setting
          label="终端字体"
          description={
            value.fontMode === "code"
              ? `跟随外观代码字体：${CODE_FONT_OPTIONS.find((font) => font.id === appearance.codeFont)?.label ?? appearance.codeFont}`
              : "仅用于终端，缺字时使用应用等宽字体。"
          }
        >
          <Select
            value={value.fontMode === "code" ? "code" : value.fontFamily}
            onValueChange={(family) => {
              if (typeof family === "string")
                void save({
                  ...value,
                  fontMode: family === "code" ? "code" : "independent",
                  fontFamily: family === "code" ? value.fontFamily : family,
                })
            }}
          >
            <SelectTrigger disabled={busy} aria-label="终端字体" className="max-w-64 min-w-44">
              <SelectValue>
                {value.fontMode === "code" ? "跟随代码字体" : value.fontFamily}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="code">跟随代码字体</SelectItem>
                {CODE_FONT_OPTIONS.map((font) => (
                  <SelectItem
                    key={font.id}
                    value={font.id === "geist-mono" ? "Geist Mono Variable" : font.label}
                    disabled={fontAvailability[font.id] === false}
                  >
                    {font.label}
                    {fontAvailability[font.id] === false ? "（未安装）" : ""}
                  </SelectItem>
                ))}
                {!["Geist Mono Variable", "Cascadia Code", "Cascadia Mono", "Consolas"].includes(
                  value.fontFamily
                ) && <SelectItem value={value.fontFamily}>{value.fontFamily}</SelectItem>}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Setting>
        <Setting label="字号">
          <Input
            placeholder="10–24 px"
            className="w-28"
            aria-label="终端字号"
            type="number"
            min={10}
            max={24}
            defaultValue={value.fontSize}
            key={`font-${value.fontSize}`}
            disabled={busy}
            onBlur={(event) => {
              const input = event.currentTarget
              if (Number(input.value) !== value.fontSize)
                void update("fontSize", Number(input.value))?.then((saved) => {
                  if (!saved) input.value = String(value.fontSize)
                })
            }}
          />
        </Setting>
        <Setting
          label="滚动历史行数"
          description="1,000–100,000 行；越大越占内存，降低可能裁剪历史。"
        >
          <Input
            aria-label="终端滚动历史行数"
            className="w-28"
            type="number"
            min={1000}
            max={100000}
            defaultValue={value.scrollback}
            key={`scroll-${value.scrollback}`}
            disabled={busy}
            onBlur={(event) => {
              const input = event.currentTarget
              if (Number(input.value) !== value.scrollback)
                void update("scrollback", Number(input.value))?.then((saved) => {
                  if (!saved) input.value = String(value.scrollback)
                })
            }}
          />
        </Setting>
        <Setting label="光标形状">
          <Select
            value={value.cursorStyle}
            onValueChange={(style) => {
              if (style === "block" || style === "bar" || style === "underline")
                update("cursorStyle", style)
            }}
          >
            <SelectTrigger disabled={busy} aria-label="光标形状" className="min-w-36">
              <SelectValue>
                {{ block: "块", bar: "竖线", underline: "下划线" }[value.cursorStyle]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="block">块</SelectItem>
                <SelectItem value="bar">竖线</SelectItem>
                <SelectItem value="underline">下划线</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Setting>
        <Setting label="光标闪烁" description="开启减少动态效果时会自动停止闪烁。">
          <Switch
            checked={value.cursorBlink}
            disabled={busy}
            aria-label="光标闪烁"
            onCheckedChange={(enabled) => update("cursorBlink", enabled)}
          />
        </Setting>
        <Setting label="多行粘贴确认" description="多行粘贴前先预览，取消则不发送。">
          <Switch
            checked={value.confirmMultilinePaste}
            disabled={busy}
            aria-label="多行粘贴确认"
            onCheckedChange={(enabled) => update("confirmMultilinePaste", enabled)}
          />
        </Setting>
        <Link
          to="/settings/$section"
          params={{ section: "keyboard" }}
          className="text-sm underline underline-offset-4"
        >
          管理终端与应用快捷键
        </Link>
      </SettingsGroup>

      <Dialog
        open={testing}
        onOpenChange={(open) => {
          if (!open) void closeTest()
        }}
      >
        <DialogContent className="flex h-[70vh] max-w-4xl flex-col">
          <DialogHeader>
            <DialogTitle>测试终端</DialogTitle>
            <DialogDescription>使用已保存设置。关闭窗口会结束测试终端。</DialogDescription>
          </DialogHeader>
          <div className="relative min-h-0 flex-1">
            <TerminalTool
              active={testing}
              activeTerminalId={testTerminal}
              openRequest={null}
              command={testCommand}
              onSessionUpsert={(record, activate) => {
                testIds.current.add(record.id)
                if (activate) setTestTerminal(record.id)
              }}
              onSessionRemove={(id) => {
                testIds.current.delete(id)
                setTestTerminal(null)
              }}
              onSessionsHydrate={() => {}}
              onActiveTerminalChange={setTestTerminal}
              onCommandSettled={() => setTestCommand(null)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Setting({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return <SettingsRow title={label} description={description} control={children} />
}
