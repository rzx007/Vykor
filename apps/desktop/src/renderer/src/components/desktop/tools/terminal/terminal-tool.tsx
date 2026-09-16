import "@xterm/xterm/css/xterm.css"

import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal as XTermTerminal } from "@xterm/xterm"
import {
  ClipboardCopy,
  ClipboardPaste,
  Eraser,
  Folder,
  Plus,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react"
import type * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { cn } from "@renderer/lib/utils"
import { Button } from "@renderer/components/ui/button"
import {
  selectActiveWorkspaceProject,
  selectActiveSessionRecord,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type {
  DesktopTerminalEvent,
  DesktopTerminalRecord,
} from "@shared/terminal-types"
import type { DesktopAgentEnvironment } from "@shared/settings-types"

import { openTerminalWebLink } from "./open-terminal-web-link"
import { userTerminalCreateInput } from "./user-terminal-create-input"
import { getXtermTheme } from "./xterm-theme"
import { resolveTerminalCreateTarget } from "./terminal-runtime-model"

type TerminalDataEvent = Extract<DesktopTerminalEvent, { type: "data" }>

type PendingAttach = {
  terminalId: string
  events: TerminalDataEvent[]
}

type TerminalContextMenuState = {
  x: number
  y: number
  selectedText: string
}

export type TerminalSessionTabInfo = {
  id: string
  title: string
}

export type TerminalPanelCommand =
  | {
      id: number
      type: "ensure" | "create"
    }
  | {
      id: number
      type: "close"
      terminalIds: string[]
    }

export function TerminalTool({
  active,
  activeTerminalId: selectedTerminalId,
  openRequest,
  command,
  onSessionUpsert,
  onSessionRemove,
  onSessionsHydrate,
  onActiveTerminalChange,
  onCommandSettled,
}: {
  active: boolean
  activeTerminalId: string | null
  openRequest: { id: number; terminalId: string } | null
  command: TerminalPanelCommand | null
  onSessionUpsert: (session: TerminalSessionTabInfo, activate: boolean) => void
  onSessionRemove: (terminalId: string) => void
  onSessionsHydrate: (sessions: TerminalSessionTabInfo[]) => void
  onActiveTerminalChange: (terminalId: string | null) => void
  onCommandSettled: (commandId: number) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeTerminalIdRef = useRef<string | null>(null)
  const activeRecordRef = useRef<DesktopTerminalRecord | null>(null)
  const recordsRef = useRef<DesktopTerminalRecord[]>([])
  const selectedProjectIdRef = useRef<string | null>(null)
  const pendingAttachRef = useRef<PendingAttach | null>(null)
  const renderedSequenceRef = useRef(new Map<string, number>())
  const closedTerminalIdsRef = useRef(new Set<string>())
  const attachGenerationRef = useRef(0)
  const creatingRef = useRef(false)
  const resizeFrameRef = useRef<number | null>(null)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const onSessionUpsertRef = useRef(onSessionUpsert)
  const onSessionRemoveRef = useRef(onSessionRemove)
  const onSessionsHydrateRef = useRef(onSessionsHydrate)
  const onActiveTerminalChangeRef = useRef(onActiveTerminalChange)
  const onCommandSettledRef = useRef(onCommandSettled)

  onSessionUpsertRef.current = onSessionUpsert
  onSessionRemoveRef.current = onSessionRemove
  onSessionsHydrateRef.current = onSessionsHydrate
  onActiveTerminalChangeRef.current = onActiveTerminalChange
  onCommandSettledRef.current = onCommandSettled

  const selectedProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const activeSession = useDesktopSessionStore(selectActiveSessionRecord)
  const rebindProject = useDesktopSessionStore((state) => state.rebindProject)
  const [records, setRecords] = useState<DesktopTerminalRecord[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null)
  const [agentEnvironment, setAgentEnvironment] = useState<DesktopAgentEnvironment>("native")

  const visibleRecords = useCallback(
    (nextRecords: DesktopTerminalRecord[]): DesktopTerminalRecord[] =>
      nextRecords.filter((record) => !closedTerminalIdsRef.current.has(record.id)),
    []
  )

  const activeRecord = useMemo(
    () =>
      records.find(
        (record) => record.id === activeTerminalId && recordBelongsToSession(record, activeSession)
      ) ?? null,
    [activeSession, activeTerminalId, records]
  )

  useEffect(() => {
    recordsRef.current = records
  }, [records])

  useEffect(() => {
    selectedProjectIdRef.current = activeSession?.id ?? null
  }, [activeSession?.id])

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings.snapshot().then((snapshot) => {
      if (!cancelled) setAgentEnvironment(snapshot.agentEnvironment)
    }).catch((caught) => {
      if (!cancelled) setError(errorMessage(caught))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
    activeRecordRef.current = activeRecord
  }, [activeRecord, activeTerminalId])

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return

    try {
      fitAddon.fit()
      const nextSize = { cols: terminal.cols, rows: terminal.rows }
      const previous = lastSizeRef.current
      if (nextSize.cols === previous.cols && nextSize.rows === previous.rows) return
      lastSizeRef.current = nextSize

      const record = activeRecordRef.current
      if (record?.status === "running") {
        void window.desktop.terminal.resize({ terminalId: record.id, ...nextSize })
      }
    } catch {
      // xterm can throw while its container is display:none during panel transitions.
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new XTermTerminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Cascadia Mono, CaskaydiaCove Nerd Font, Consolas, Microsoft YaHei UI, monospace",
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.22,
      minimumContrastRatio: 4.5,
      scrollback: 5_000,
      theme: getXtermTheme(),
      windowsMode: window.navigator.userAgent.includes("Windows"),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon((_event, uri) => openTerminalWebLink(uri)))
    terminal.open(container)
    terminal.onData((data) => {
      const record = activeRecordRef.current
      if (record?.status === "running") {
        void window.desktop.terminal.write({ terminalId: record.id, data })
      }
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    setTerminalReady(true)
    fitAndResize()

    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = window.requestAnimationFrame(fitAndResize)
    })
    observer.observe(container)

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = getXtermTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      if (resizeFrameRef.current) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
      attachGenerationRef.current += 1
      pendingAttachRef.current = null
      setTerminalReady(false)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitAndResize])

  const createTerminal = useCallback(
    async (
      preferredName?: string,
      knownRecords?: DesktopTerminalRecord[]
    ): Promise<void> => {
      const project = selectedProject
      const terminal = terminalRef.current
      if (!project?.available || !activeSession || !terminal || creatingRef.current) return

      creatingRef.current = true
      setCreating(true)
      setError(null)
      fitAndResize()

      const currentRecords = knownRecords ?? recordsRef.current
      const target = resolveTerminalCreateTarget({ session: activeSession })
      const name = preferredName ?? nextTerminalName(currentRecords, activeSession.id)

      try {
        const nextRecord = await window.desktop.terminal.create(
          userTerminalCreateInput({
            ...target,
            name,
            cols: terminal.cols || 80,
            rows: terminal.rows || 24,
          })
        )
        setRecords((current) => [
          ...current.filter((record) => record.id !== nextRecord.id),
          nextRecord,
        ])
        if (selectedProjectIdRef.current === activeSession.id) {
          setActiveTerminalId(nextRecord.id)
          onSessionUpsertRef.current(toTabInfo(nextRecord), true)
          onActiveTerminalChangeRef.current(nextRecord.id)
        }
      } catch (caught) {
        setError(errorMessage(caught))
      } finally {
        creatingRef.current = false
        setCreating(false)
      }
    },
    [activeSession, agentEnvironment, fitAndResize, selectedProject]
  )

  useEffect(() => {
    if (!selectedTerminalId) return
    setActiveTerminalId(selectedTerminalId)
  }, [selectedTerminalId])

  useEffect(() => {
    if (!terminalReady || !active) return
    if (!selectedProject?.available || !activeSession) return

    let cancelled = false
    void window.desktop.terminal
      .list()
      .then((nextRecords) => {
        if (cancelled) return
        setRecords(visibleRecords(nextRecords))
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught))
      })

    return () => {
      cancelled = true
    }
  }, [active, activeSession, selectedProject?.available, selectedProject?.id, terminalReady, visibleRecords])

  useEffect(() => {
    if (!openRequest || !terminalReady) return
    let cancelled = false
    void window.desktop.terminal
      .list()
      .then((nextRecords) => {
        if (cancelled) return
        const requested = nextRecords.find((record) => record.id === openRequest.terminalId)
        if (!requested) throw new Error("Terminal is no longer available.")
        closedTerminalIdsRef.current.delete(requested.id)
        setRecords(visibleRecords(nextRecords))
        setActiveTerminalId(requested.id)
        onSessionUpsertRef.current(toTabInfo(requested), true)
        onActiveTerminalChangeRef.current(requested.id)
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [openRequest, terminalReady, visibleRecords])

  useEffect(() => {
    if (!terminalReady) return
    const terminal = terminalRef.current
    if (!terminal) return

    const generation = ++attachGenerationRef.current
    pendingAttachRef.current = null
    terminal.reset()

    if (!activeTerminalId) return

    const pending: PendingAttach = { terminalId: activeTerminalId, events: [] }
    pendingAttachRef.current = pending

    void window.desktop.terminal
      .read({ terminalId: activeTerminalId })
      .then((snapshot) => {
        if (generation !== attachGenerationRef.current) return
        terminal.reset()
        if (snapshot.truncated) {
          terminal.writeln("\x1b[2m[Earlier terminal output was trimmed]\x1b[0m")
        }
        terminal.write(snapshot.data)
        let renderedSequence = snapshot.sequence
        for (const event of pending.events) {
          if (event.sequence <= renderedSequence) continue
          terminal.write(event.data)
          renderedSequence = event.sequence
        }
        renderedSequenceRef.current.set(activeTerminalId, renderedSequence)
        pendingAttachRef.current = null
        fitAndResize()
        if (active) terminal.focus()
      })
      .catch((caught) => {
        if (generation !== attachGenerationRef.current) return
        pendingAttachRef.current = null
        const message = errorMessage(caught)
        setError(message)
        terminal.writeln(`\r\nTerminal attach failed: ${message}`)
      })
  }, [active, activeTerminalId, fitAndResize, terminalReady])

  useEffect(() => {
    return window.desktop.terminal.onEvent((event) => {
      if (event.type === "data") {
        if (event.terminalId !== activeTerminalIdRef.current) return
        const renderedSequence = renderedSequenceRef.current.get(event.terminalId) ?? 0
        if (event.sequence <= renderedSequence) return
        const pending = pendingAttachRef.current
        if (pending?.terminalId === event.terminalId) {
          pending.events.push(event)
        } else {
          terminalRef.current?.write(event.data)
          renderedSequenceRef.current.set(event.terminalId, event.sequence)
        }
        return
      }

      if (event.type === "exit") {
        setRecords((current) =>
          current.map((record) =>
            record.id === event.terminalId
              ? {
                  ...record,
                  status:
                    record.status === "stopping" || record.status === "killed"
                      ? "killed"
                      : event.exitCode === 0
                        ? "completed"
                        : "failed",
                  exitedAt: new Date().toISOString(),
                  exitCode: event.exitCode,
                }
              : record
          )
        )
        if (event.terminalId === activeTerminalIdRef.current) {
          terminalRef.current?.writeln(
            `\r\n\x1b[2m[Process exited with code ${event.exitCode ?? "unknown"}]\x1b[0m`
          )
        }
        return
      }

      if (event.type === "status") {
        setRecords((current) =>
          current.map((record) =>
            record.id === event.terminalId ? { ...record, status: event.status } : record
          )
        )
        return
      }

      if (event.type === "error" && event.terminalId === activeTerminalIdRef.current) {
        setError(event.message)
        terminalRef.current?.writeln(`\r\n${event.message}`)
      }
    })
  }, [])

  useEffect(() => {
    if (!active) return
    fitAndResize()
    terminalRef.current?.focus()
  }, [active, fitAndResize])

  useEffect(() => {
    if (!contextMenu) return

    const handlePointerDown = (event: PointerEvent): void => {
      const menu = contextMenuRef.current
      if (menu?.contains(event.target as Node)) return
      setContextMenu(null)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setContextMenu(null)
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [contextMenu])

  const closeTerminal = async (
    terminalId: string,
    options?: { notifyParent?: boolean }
  ): Promise<void> => {
    renderedSequenceRef.current.delete(terminalId)
    closedTerminalIdsRef.current.add(terminalId)
    const remaining = recordsRef.current.filter((record) => record.id !== terminalId)
    recordsRef.current = remaining
    setRecords(remaining)
    if (options?.notifyParent !== false) onSessionRemoveRef.current(terminalId)

    try {
      await window.desktop.terminal.kill(terminalId)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  useEffect(() => {
    if (!command) return

    if (command.type === "close") {
      let cancelled = false
      void Promise.all(
        command.terminalIds.map((terminalId) => closeTerminal(terminalId, { notifyParent: false }))
      ).finally(() => {
        if (!cancelled) onCommandSettledRef.current(command.id)
      })
      return () => {
        cancelled = true
      }
    }

    if (!terminalReady) return

    if (command.type === "create") {
      let cancelled = false
      void createTerminal().finally(() => {
        if (!cancelled) onCommandSettledRef.current(command.id)
      })
      return () => {
        cancelled = true
      }
    }

    if (!selectedProject?.available || !activeSession) {
      onCommandSettledRef.current(command.id)
      return
    }

    let cancelled = false
    void window.desktop.terminal
      .list()
      .then(async (nextRecords) => {
        if (cancelled) return
        const nextVisibleRecords = visibleRecords(nextRecords)
        setRecords(nextVisibleRecords)
        const currentProjectRecords = nextVisibleRecords.filter(
          (record) => recordBelongsToSession(record, activeSession)
        )
        if (currentProjectRecords.length === 0) {
          await createTerminal(undefined, nextRecords)
          return
        }
        onSessionsHydrateRef.current(currentProjectRecords.map(toTabInfo))
        const currentActive = currentProjectRecords.find(
          (record) => record.id === activeTerminalIdRef.current || record.id === selectedTerminalId
        )
        const firstRunning = currentProjectRecords.find((record) => record.status === "running")
        const firstRecord = currentActive ?? firstRunning ?? currentProjectRecords[0]
        setActiveTerminalId(firstRecord.id)
        onActiveTerminalChangeRef.current(firstRecord.id)
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) onCommandSettledRef.current(command.id)
      })

    return () => {
      cancelled = true
    }
  }, [
    command,
    createTerminal,
    selectedProject?.available,
    selectedProject?.id,
    activeSession,
    selectedTerminalId,
    terminalReady,
    visibleRecords,
  ])

  const restartTerminal = async (): Promise<void> => {
    const record = activeRecordRef.current
    if (!record) return
    renderedSequenceRef.current.delete(record.id)
    const remaining = recordsRef.current.filter((item) => item.id !== record.id)
    setActiveTerminalId(null)
    setRecords(remaining)
    onSessionRemoveRef.current(record.id)

    try {
      await window.desktop.terminal.kill(record.id)
      await createTerminal(record.name, remaining)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const clearTerminal = (): void => {
    const record = activeRecordRef.current
    terminalRef.current?.clear()
    if (record?.status === "running") {
      void window.desktop.terminal.write({ terminalId: record.id, data: "\x0c" })
    }
  }

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const terminal = terminalRef.current
    const selectedText = terminal?.hasSelection() ? terminal.getSelection() : ""
    const position = clampContextMenuPosition(event.clientX, event.clientY)
    setContextMenu({ ...position, selectedText })
  }

  const copySelection = async (): Promise<void> => {
    const selectedText = contextMenu?.selectedText
    setContextMenu(null)
    if (!selectedText) return
    await window.desktop.clipboard.writeText(selectedText)
    terminalRef.current?.focus()
  }

  const pasteClipboard = async (): Promise<void> => {
    setContextMenu(null)
    const record = activeRecordRef.current
    if (record?.status !== "running") return
    const text = await window.desktop.clipboard.readText()
    if (text) await window.desktop.terminal.write({ terminalId: record.id, data: text })
    terminalRef.current?.focus()
  }

  const clearFromMenu = (): void => {
    setContextMenu(null)
    clearTerminal()
    terminalRef.current?.focus()
  }

  const restartFromMenu = async (): Promise<void> => {
    setContextMenu(null)
    await restartTerminal()
  }

  const closeFromMenu = async (): Promise<void> => {
    const record = activeRecordRef.current
    setContextMenu(null)
    if (record) await closeTerminal(record.id)
  }

  return (
    <section
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 flex h-full min-h-0 flex-col bg-conversation transition-opacity duration-100",
        !active && "pointer-events-none opacity-0"
      )}
    >
      <div className="relative min-h-0 flex-1 bg-background/55">
        <div
          ref={containerRef}
          onContextMenu={openContextMenu}
          className="desktop-terminal h-full min-h-0 w-full p-2"
        />

        {contextMenu && (
          <TerminalContextMenu
            menuRef={contextMenuRef}
            state={contextMenu}
            canPaste={activeRecord?.status === "running"}
            canManage={Boolean(activeRecord)}
            onCopy={() => void copySelection()}
            onPaste={() => void pasteClipboard()}
            onClear={clearFromMenu}
            onRestart={() => void restartFromMenu()}
            onClose={() => void closeFromMenu()}
          />
        )}

        {(!activeSession || !selectedProject || !selectedProject.available) && (
          <div className="absolute inset-0 grid place-items-center bg-conversation/90 px-8 text-center backdrop-blur-sm">
            <div className="max-w-sm">
              <Folder className="mx-auto mb-3 size-9 text-ui-muted" strokeWidth={1.6} />
              <h2 className="text-base font-semibold text-ui-foreground">
                {!activeSession ? "未选择会话" : selectedProject ? "项目目录不可用" : "未选择项目"}
              </h2>
              <p className="text-ui-small mt-2 leading-6 text-ui-muted">
                {!activeSession
                  ? "打开一个会话后，终端会使用该会话的可信工作目录。"
                  : selectedProject
                  ? "当前项目目录可能已被移动，请重新绑定目录后再启动终端。"
                  : "选择项目后，终端会在项目目录中启动。"}
              </p>
              {activeSession && selectedProject && (
                <Button
                  type="button"
                  className="mt-4"
                  onClick={() => void rebindProject(selectedProject.id)}
                >
                  重新绑定目录
                </Button>
              )}
            </div>
          </div>
        )}

        {activeSession && selectedProject?.available && !activeRecord && !creating && (
          <div className="absolute inset-0 grid place-items-center bg-conversation/84 px-8 text-center backdrop-blur-sm">
            <div>
              <SquareTerminal className="mx-auto mb-3 size-9 text-ui-muted" strokeWidth={1.6} />
              <p className="text-ui-small text-ui-muted">当前会话没有打开的终端</p>
              <p className="text-ui-caption mt-1 text-ui-muted">
                默认打开{agentEnvironment === "wsl" ? " WSL 终端" : "本机终端"}。
              </p>
              <div className="mt-4 flex justify-center">
                <Button type="button" onClick={() => void createTerminal()}>
                  <Plus data-icon="inline-start" />
                  新建{agentEnvironment === "wsl" ? " WSL 终端" : "本机终端"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && selectedProject?.available && (
          <div className="absolute right-3 bottom-3 max-w-[calc(100%-1.5rem)] rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
            <span>{error}</span>
            <Button
              type="button"
              variant="link"
              onClick={() => setError(null)}
              className="ml-3 h-auto px-0 text-xs text-foreground"
            >
              关闭
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

function TerminalContextMenu({
  menuRef,
  state,
  canPaste,
  canManage,
  onCopy,
  onPaste,
  onClear,
  onRestart,
  onClose,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>
  state: TerminalContextMenuState
  canPaste: boolean
  canManage: boolean
  onCopy: () => void
  onPaste: () => void
  onClear: () => void
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left: state.x, top: state.y }}
      className="text-ui-small fixed z-[100] w-44 rounded-md border border-border/80 bg-popover p-1 text-popover-foreground shadow-xl outline-none"
    >
      <TerminalContextMenuItem disabled={!state.selectedText} onClick={onCopy}>
        <ClipboardCopy />
        复制选区
      </TerminalContextMenuItem>
      <TerminalContextMenuItem disabled={!canPaste} onClick={onPaste}>
        <ClipboardPaste />
        粘贴
      </TerminalContextMenuItem>
      <div role="separator" className="-mx-1 my-1 h-px bg-border/75" />
      <TerminalContextMenuItem disabled={!canManage} onClick={onClear}>
        <Eraser />
        清空
      </TerminalContextMenuItem>
      <TerminalContextMenuItem disabled={!canManage} onClick={onRestart}>
        <RotateCcw />
        重启
      </TerminalContextMenuItem>
      <TerminalContextMenuItem disabled={!canManage} onClick={onClose} destructive>
        <X />
        关闭
      </TerminalContextMenuItem>
    </div>
  )
}

function TerminalContextMenuItem({
  disabled,
  destructive,
  onClick,
  children,
}: {
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded px-2 text-left transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
        destructive &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive"
      )}
    >
      {children}
    </button>
  )
}

function nextTerminalName(records: DesktopTerminalRecord[], sessionId: string): string {
  const used = new Set(
    records
      .filter((record) => record.scope.kind === "session" && record.scope.sessionId === sessionId)
      .map((record) => /^Terminal (\d+)$/.exec(record.name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
  )
  let index = 1
  while (used.has(index)) index += 1
  return `Terminal ${index}`
}

function recordBelongsToSession(
  record: DesktopTerminalRecord,
  session: { id: string; projectId?: string } | null
): boolean {
  if (!session) return false
  if (record.scope.kind === "session") return record.scope.sessionId === session.id
  return Boolean(session.projectId && record.scope.projectId === session.projectId)
}

function clampContextMenuPosition(x: number, y: number): { x: number; y: number } {
  const width = 176
  const height = 200
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function shellName(shell: string): string {
  return (
    shell
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.exe$/i, "") || shell
  )
}

function toTabInfo(record: DesktopTerminalRecord): TerminalSessionTabInfo {
  return {
    id: record.id,
    title: `${shellName(record.shell)}:${record.cwd}`,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}
