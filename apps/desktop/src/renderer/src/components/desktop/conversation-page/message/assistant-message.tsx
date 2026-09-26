import {
  AlertCircle,
  ChevronDown,
  FileCode2,
  PanelRightOpen,
  Pencil,
  TerminalSquare,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Streamdown } from "streamdown"

import { Button } from "@renderer/components/ui/button"
import { AttachmentGroup } from "@renderer/components/ui/attachment"
import { queryGitChanges } from "@renderer/lib/git-changes-query"
import { cn } from "@renderer/lib/utils"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type { DesktopSessionPart } from "@shared/session-types"
import { routeChangedFileClick, toProjectRelativePath } from "@shared/workspace-open-path"

import {
  buildAssistantContent,
  collectChangedFiles,
  formatValue,
  isTurnComplete,
  summarizeToolCall,
  toolDisplayName,
  type AssistantContentUnit,
  type ChangedFile,
} from "./message-render-model"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins } from "./streamdown-plugins"
import { truncateReasoning } from "./reasoning-text"
import { MessageAttachment } from "./message-attachment"
import { GeneratedImageGallery, ImageGenerationMessage } from "./image-generation-message"

type ChangedFileStats = {
  additions: number
  deletions: number
}

export function AssistantMessage({
  parts,
  streaming,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  parts: DesktopSessionPart[]
  streaming: boolean
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const units = useMemo(() => buildAssistantContent(parts), [parts])
  const blocks = useMemo(() => groupToolUnits(units), [units])
  const changedFiles = useMemo(() => collectChangedFiles(parts), [parts])
  if (parts.length === 0) return <span className="text-xs text-ui-muted">正在生成回复...</span>

  return (
    <div className="group/assistant min-w-0 space-y-3">
      {blocks.map((block, index) => {
        if (block.type === "tool-group") {
          return <ToolActivityGroup key={block.id} tools={block.tools} />
        }
        if (block.type === "terminal") {
          return (
            <TerminalActivityCard
              key={block.id}
              payload={block.payload}
              active={isTerminalActivityActive(block, streaming && index === blocks.length - 1)}
              onOpenTerminal={onOpenTerminal}
            />
          )
        }
        const unit = block.unit
        if (unit.type === "markdown") {
          return (
            <AssistantMarkdown
              key={unit.id}
              text={unit.text}
              phase={unit.phase}
              streaming={streaming && index === blocks.length - 1}
              onOpenFile={onOpenFile}
            />
          )
        }
        if (unit.type === "reasoning") {
          const truncated = truncateReasoning(unit.text)
          return (
            <details key={unit.id} className="text-ui-small text-ui-muted">
              <summary className="w-fit cursor-pointer font-medium select-none hover:text-foreground">
                思考过程
              </summary>
              <p className="mt-2 border-l pl-3.5 leading-6 whitespace-pre-wrap">{truncated.text}</p>
              {truncated.omitted > 0 ? (
                <p className="text-ui-caption mt-1 text-ui-muted">
                  已省略前 {truncated.omitted} 个字符
                </p>
              ) : null}
            </details>
          )
        }
        if (unit.type === "image_generation") {
          return (
            <ImageGenerationMessage
              key={unit.id}
              call={unit.call}
              hasAttachments={unit.hasAttachments}
              streaming={streaming}
            />
          )
        }
        if (unit.type === "attachments") {
          const containsImage = unit.parts.some((part) => part.mediaType.startsWith("image/"))
          const containsFile = unit.parts.some((part) => !part.mediaType.startsWith("image/"))
          return (
            <AttachmentGroup key={unit.id} aria-label="生成的附件" className="max-w-full">
              {unit.parts.map((part) => (
                <MessageAttachment
                  key={part.id}
                  part={part}
                  alignMixedAttachmentHeights={containsImage && containsFile}
                />
              ))}
            </AttachmentGroup>
          )
        }
        if (unit.type === "generated_attachments") {
          return <GeneratedImageGallery key={unit.id} parts={unit.parts} ratio={unit.ratio} />
        }
        return (
          <div
            key={unit.id}
            className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-pre-wrap">{unit.text}</span>
          </div>
        )
      })}

      {!streaming && isTurnComplete(parts) && changedFiles.length > 0 ? (
        <ChangedFilesSummary
          files={changedFiles}
          canOpenReview={canOpenReview}
          onOpenFile={onOpenFile}
          onOpenReview={onOpenReview}
        />
      ) : null}
    </div>
  )
}

function AssistantMarkdown({
  text,
  phase,
  streaming,
  onOpenFile,
}: {
  text: string
  phase?: "commentary" | "final_answer"
  streaming: boolean
  onOpenFile: (path: string, line?: number) => void
}): React.JSX.Element {
  const components = useMemo(() => createStreamdownComponents({ onOpenFile }), [onOpenFile])

  return (
    <div className="assistant-markdown min-w-0" data-phase={phase}>
      <Streamdown
        className="desktop-streamdown space-y-0"
        animated
        mode={streaming ? "streaming" : "static"}
        controls
        lineNumbers={false}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  )
}

type ToolUnit = Extract<AssistantContentUnit, { type: "tool" }>
type ContentBlock =
  | { id: string; type: "unit"; unit: Exclude<AssistantContentUnit, ToolUnit> }
  | { id: string; type: "tool-group"; tools: ToolUnit[] }
  | { id: string; type: "terminal"; payload: TerminalToolPayload; tool: ToolUnit }

function isToolInFlight(tool: ToolUnit): boolean {
  const status = tool.call.status
  if (status === "pending" || status === "running") return true
  return !tool.result && status !== "completed" && status !== "failed" && status !== "interrupted"
}

function isTerminalActivityActive(
  block: Extract<ContentBlock, { type: "terminal" }>,
  isLiveTail: boolean
): boolean {
  if (isToolInFlight(block.tool)) return true
  return isLiveTail && block.payload.terminal?.status === "running"
}

function groupToolUnits(units: AssistantContentUnit[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const unit of units) {
    if (unit.type !== "tool") {
      blocks.push({ id: unit.id, type: "unit", unit })
      continue
    }
    const terminal = parseTerminalToolPayload(unit.call.output ?? unit.result?.output)
    if (terminal?.action === "open" && terminal.terminal) {
      blocks.push({ id: `terminal-${unit.id}`, type: "terminal", payload: terminal, tool: unit })
      continue
    }
    const previous = blocks.at(-1)
    if (previous?.type === "tool-group") previous.tools.push(unit)
    else blocks.push({ id: `tools-${unit.id}`, type: "tool-group", tools: [unit] })
  }
  return blocks
}

type TerminalToolPayload = {
  kind: "terminal"
  action: string
  terminal?: {
    id: string
    name: string
    cwd: string
    shell: string
    status: "running" | "stopping" | "completed" | "killed" | "failed"
  }
}

function TerminalActivityCard({
  payload,
  active,
  onOpenTerminal,
}: {
  payload: TerminalToolPayload
  active: boolean
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element | null {
  const terminal = payload.terminal
  if (!terminal) return null
  return (
    <section className="text-ui-small overflow-hidden rounded-lg border border-border/80 bg-muted/18 shadow-sm">
      <div className="flex min-h-16 items-center gap-3 px-3.5 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-ui-muted">
          <TerminalSquare className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                terminal.status === "running" ? "bg-emerald-500" : "bg-ui-muted/60"
              )}
            />
            <h3 className={cn("truncate font-semibold text-foreground", active && "shimmer")}>
              {terminal.name}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-xs text-ui-muted" title={terminal.cwd}>
            {terminal.cwd}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => onOpenTerminal(terminal.id)}>
          <PanelRightOpen data-icon="inline-start" />
          打开终端
        </Button>
      </div>
    </section>
  )
}

function parseTerminalToolPayload(value: unknown): TerminalToolPayload | null {
  const text = terminalPayloadText(value)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<TerminalToolPayload>
    return parsed.kind === "terminal" && typeof parsed.action === "string"
      ? (parsed as TerminalToolPayload)
      : null
  } catch {
    return null
  }
}

function terminalPayloadText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return null
  const content = "content" in value ? value.content : undefined
  if (!Array.isArray(content)) return null
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      !!item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
  )
  return block?.text ?? null
}

function ToolActivityGroup({ tools }: { tools: ToolUnit[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = tools.some(isToolInFlight)
  const edits = tools.filter((tool) =>
    /write|edit|patch|create|delete/i.test(tool.call.toolName ?? "")
  )
  const commands = tools.filter((tool) =>
    /bash|shell|terminal|exec|command/i.test(tool.call.toolName ?? "")
  )
  const reads = tools.length - edits.length - commands.length
  const activityHeading = [
    edits.length ? `编辑了 ${edits.length} 个文件` : "",
    commands.length ? `运行了 ${commands.length} 个命令` : "",
    reads > 0 ? `执行了 ${reads} 次查看` : "",
  ]
    .filter(Boolean)
    .join("，")
  const onlyToolSummary = tools.length === 1 ? summarizeToolCall(tools[0]!.call) : undefined
  const heading =
    tools.length === 1 && tools[0]!.call.toolName === "ImageToText"
      ? onlyToolSummary?.name
      : activityHeading
  return (
    <section className="text-ui-small text-ui-muted">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-7 max-w-full items-center gap-2 hover:text-foreground",
          active && "shimmer"
        )}
      >
        <Pencil className="size-3.5 shrink-0" strokeWidth={1.7} />
        <span className="truncate">{heading || `执行了 ${tools.length} 个工具`}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="mt-1 space-y-0.5 border-l border-border/70 pl-4">
          {tools.map((tool) => {
            const summary = summarizeToolCall(tool.call)
            const active = activeId === tool.id
            const calling = isToolInFlight(tool)
            const output = tool.result?.output ?? tool.call.output ?? tool.call.input
            return (
              <div key={tool.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(active ? null : tool.id)}
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-2 text-left hover:text-foreground",
                    calling && "shimmer"
                  )}
                >
                  <TerminalSquare className="size-3.5 shrink-0" strokeWidth={1.6} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-ui-foreground">{summary.name}</span>
                    {summary.detail ? (
                      <span className="ml-1.5 text-ui-muted/80">{summary.detail}</span>
                    ) : null}
                  </span>
                  <ChevronDown
                    className={cn("size-3.5 shrink-0 transition-transform", active && "rotate-180")}
                  />
                </button>
                {active ? (
                  <div className="mb-2 overflow-hidden rounded-md border bg-muted/30">
                    <div className="border-b px-3 py-1.5 text-xs">
                      {toolDisplayName(tool.call, tool.result)}
                    </div>
                    <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">
                      {formatValue(output)}
                    </pre>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

export function ChangedFilesSummary({
  files,
  canOpenReview,
  onOpenFile,
  onOpenReview,
}: {
  files: ChangedFile[]
  canOpenReview: boolean
  onOpenFile: (path: string, line?: number) => void
  onOpenReview: (path?: string) => void
}): React.JSX.Element {
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectPath = workspaceProject?.path
  const [expanded, setExpanded] = useState(false)
  const [gitStatsByPath, setGitStatsByPath] = useState<Record<string, ChangedFileStats>>({})
  const fileKey = useMemo(
    () =>
      files
        .map((file) => {
          const path = normalizeReviewPath(
            toProjectRelativePath(file.path, selectedProjectPath) ?? file.path
          )
          return `${path}:${file.additions}:${file.deletions}:${file.hasStats ? "stats" : "patch"}`
        })
        .join("\n"),
    [files, selectedProjectPath]
  )

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!canOpenReview || !selectedProjectPath || files.length === 0) {
        setGitStatsByPath({})
        return
      }

      void queryGitChanges({
        rootPath: selectedProjectPath,
        scope: "uncommitted",
      })
        .then((result) => {
          if (cancelled) return
          const stats: Record<string, ChangedFileStats> = {}
          for (const file of result.files) {
            if (file.additions === null && file.deletions === null) continue
            stats[normalizeReviewPath(file.path)] = {
              additions: file.additions ?? 0,
              deletions: file.deletions ?? 0,
            }
          }
          setGitStatsByPath(stats)
        })
        .catch(() => {
          if (cancelled) return
          setGitStatsByPath({})
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [canOpenReview, fileKey, files.length, selectedProjectPath])

  const filesWithStats = useMemo(
    () =>
      files.map((file) => {
        const stats =
          gitStatsByPath[
            normalizeReviewPath(toProjectRelativePath(file.path, selectedProjectPath) ?? file.path)
          ]
        return stats ? { ...file, ...stats, hasStats: true } : file
      }),
    [files, gitStatsByPath, selectedProjectPath]
  )
  const visible = expanded ? filesWithStats : filesWithStats.slice(0, 3)
  const hasStats = filesWithStats.some((file) => file.hasStats)
  const statsFiles = hasStats ? filesWithStats.filter((file) => file.hasStats) : filesWithStats
  const additions = statsFiles.reduce((total, file) => total + file.additions, 0)
  const deletions = statsFiles.reduce((total, file) => total + file.deletions, 0)

  return (
    <section className="text-ui-small overflow-hidden rounded-lg border bg-transparent">
      <header className="flex min-h-15 items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted/75 text-ui-muted">
          <FileCode2 className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">已编辑 {files.length} 个文件</h3>
          {hasStats ? (
            <p className="mt-0.5">
              <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
              <span className="text-red-500">-{deletions}</span>
            </p>
          ) : null}
        </div>
      </header>
      <div className="border-t">
        {visible.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() =>
              routeChangedFileClick(file.path, selectedProjectPath, canOpenReview) === "review"
                ? onOpenReview(file.path)
                : onOpenFile(file.path)
            }
            className="flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-ui-muted">{file.path}</span>
            {file.hasStats ? (
              <LineStats additions={file.additions} deletions={file.deletions} />
            ) : null}
          </button>
        ))}
      </div>
      {!expanded && files.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-9 items-center gap-2 px-3 font-medium text-ui-muted hover:text-foreground"
        >
          再显示 {files.length - 3} 个文件 <ChevronDown className="size-3.5" />
        </button>
      ) : null}
    </section>
  )
}

function LineStats({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}): React.JSX.Element {
  return (
    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
      <span className="ml-1 text-red-500">-{deletions}</span>
    </span>
  )
}

function normalizeReviewPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase()
}
