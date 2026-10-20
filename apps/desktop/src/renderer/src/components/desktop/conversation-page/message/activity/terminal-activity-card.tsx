import { ChevronDown, CircleStop, PanelRightOpen, TerminalSquare } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { DesktopTerminalRecord } from "@shared/terminal-types"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import { terminalStatusLabel, terminalErrorMessage } from "../../../tools/terminal/terminal-display"

export type TerminalActivityInfo = Pick<
  DesktopTerminalRecord,
  "id" | "name" | "cwd" | "shell" | "status" | "command"
>

export function TerminalActivityCard({
  terminal,
  active,
  onOpenTerminal,
}: {
  terminal: TerminalActivityInfo
  active: boolean
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const [current, setCurrent] = useState<TerminalActivityInfo | null>(null)
  const [availability, setAvailability] = useState<"checking" | "ready" | "missing" | "error">(
    "checking"
  )
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialTerminalRef = useRef(terminal)
  const refreshRef = useRef(() => {})
  initialTerminalRef.current = terminal
  const terminalId = terminal.id

  useEffect(() => {
    let disposed = false
    let revision = 0
    setCurrent(null)
    setAvailability("checking")
    setError(null)
    const refresh = () => {
      const requestRevision = ++revision
      void window.desktop.terminal
        .list()
        .then((records) => {
          if (disposed || requestRevision !== revision) return
          const record = records.find((item) => item.id === terminalId) ?? null
          setCurrent(record)
          setAvailability(record ? "ready" : "missing")
          setError(null)
        })
        .catch((caught) => {
          if (disposed || requestRevision !== revision) return
          setAvailability("error")
          setError(terminalErrorMessage(caught))
        })
    }
    const unsubscribe = window.desktop.terminal.onEvent((event) => {
      if (event.terminalId !== terminalId || (event.type !== "exit" && event.type !== "status"))
        return
      revision += 1
      setAvailability("ready")
      setCurrent((record) => {
        const previous = record ?? initialTerminalRef.current
        const status =
          event.type === "status"
            ? event.status
            : previous.status === "stopping" || previous.status === "killed"
              ? "killed"
              : event.exitCode === 0
                ? "completed"
                : "failed"
        return { ...previous, status }
      })
    })
    refreshRef.current = refresh
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener("focus", refresh)
    }
  }, [terminalId])

  const info = current ?? terminal
  const running = availability === "ready" && info.status === "running"
  const label =
    availability === "checking"
      ? "查询状态…"
      : availability === "missing"
        ? "终端已不可用"
        : availability === "error"
          ? "状态查询失败"
          : terminalStatusLabel(info.status)
  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await window.desktop.terminal.kill(terminal.id)
      refreshRef.current()
    } catch (caught) {
      setError(terminalErrorMessage(caught))
    } finally {
      setStopping(false)
    }
  }
  const settled =
    availability === "ready" &&
    !active &&
    !error &&
    (info.status === "completed" || info.status === "killed")

  if (settled) {
    return (
      <section className="text-ui-small flex items-start gap-2 text-ui-muted">
        <details className="group/terminal min-w-0 flex-1">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">{info.name}</span>
            <span className="shrink-0 text-xs" role="status">
              {label}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform group-open/terminal:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <p className="mt-1 border-l border-border/70 pl-3 text-xs break-all">
            {info.command ?? info.cwd}
          </p>
        </details>
        <Button
          type="button"
          variant="ghost"
          shape="pill"
          size="sm"
          className="h-8 shrink-0"
          onClick={() => onOpenTerminal(terminal.id)}
        >
          <PanelRightOpen data-icon="inline-start" />
          打开终端
        </Button>
      </section>
    )
  }
  return (
    <section className="text-ui-small overflow-hidden rounded-lg border border-border/80 bg-muted/18">
      <div className="flex min-h-16 items-center gap-3 px-3.5 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-ui-muted">
          <TerminalSquare className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                running ? "bg-primary" : "bg-ui-muted/60"
              )}
            />
            <h3 className={cn("truncate font-semibold text-foreground", active && "shimmer")}>
              {info.name}
            </h3>
            <span className="shrink-0 text-xs text-ui-muted" role="status">
              {label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-ui-muted" title={info.command ?? info.cwd}>
            {info.command ?? info.cwd}
          </p>
          {error && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        {running && (
          <Button
            type="button"
            variant="control"
            shape="pill"
            size="lg"
            className="h-9 gap-1.5"
            disabled={stopping}
            onClick={() => void stop()}
          >
            <CircleStop data-icon="inline-start" />
            {info.command ? "停止服务" : "停止终端"}
          </Button>
        )}
        <Button
          type="button"
          variant="control"
          shape="pill"
          size="lg"
          className="h-9 gap-1.5"
          disabled={availability !== "ready"}
          onClick={() => onOpenTerminal(terminal.id)}
        >
          <PanelRightOpen data-icon="inline-start" />
          打开终端
        </Button>
      </div>
    </section>
  )
}
