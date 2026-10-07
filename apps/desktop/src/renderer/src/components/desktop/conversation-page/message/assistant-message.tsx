import {
  AlertCircle,
  ChevronDown,
  FileCode2,
  LoaderCircle,
  PanelRightOpen,
  Pencil,
  TerminalSquare,
} from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import type { WorkspaceChangesMetadata } from "@vykor/client"
import type { DesktopGitDiffScope } from "@shared/git-types"
import { Streamdown } from "streamdown"

import { Button } from "@renderer/components/ui/button"
import { AttachmentGroup } from "@renderer/components/ui/attachment"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { queryGitChanges } from "@renderer/lib/git-changes-query"
import { cn } from "@renderer/lib/utils"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import { isAbsoluteFileInRepository, routeChangedFileClick, toProjectRelativePath } from "@shared/workspace-open-path"

import {
  buildAssistantContent,
  collectChangedFiles,
  formatValue,
  isTurnComplete,
  summarizeToolCall,
  toolCallStatus,
  toolActivityLabel,
  toolGroupActivityLabel,
  isToolActivityActive,
  toolDisplayName,
  type AssistantContentUnit,
  type ChangedFile,
} from "./message-render-model"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins } from "./streamdown-plugins"
import { truncateReasoning } from "./reasoning-text"
import { MessageAttachment } from "./message-attachment"
import { GeneratedImageGallery, ImageGenerationMessage } from "./image-generation-message"
import { ContentEntrance } from "./content-entrance"
import { AgentActivityMessage } from "./agent-activity-message"
import { toolOutputText } from "./message-content"
import { isToolGenerationPresentation } from "./tool-generation-presentation"
import { useToolDetails } from "./use-tool-details"
import { PluginUiCard } from "../plugin-ui/plugin-ui-card"

const emptyAgentTasks: DesktopSessionTask[] = []
const diagnosticToolLabels = new Set(["失败", "已中断", "结果不确定", "工具失败，等待本轮结果"])

type ChangedFileStats = {
  additions: number
  deletions: number
}

const streamingTextAnimation = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease-out",
  sep: "char",
  stagger: 0,
} as const

export function AssistantMessage({
  parts,
  observations,
  showObservations = true,
  streaming,
  initialPartIds,
  tasks = emptyAgentTasks,
  onOpenAgents,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  parts: DesktopSessionPart[]
  observations?: WorkspaceChangesMetadata[]
  showObservations?: boolean
  streaming: boolean
  /** 打开聊天时已有的内容，不重复播放入场。 */
  initialPartIds?: ReadonlySet<string>
  tasks?: DesktopSessionTask[]
  onOpenAgents?: (taskId?: string) => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string, scope?: DesktopGitDiffScope, rootPath?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const units = useMemo(() => buildAssistantContent(parts), [parts])
  const blocks = useMemo(() => groupToolUnits(units), [units])
  const changedFiles = useMemo(() => collectChangedFiles(parts), [parts])
  const fileIdentityLimits = parts.flatMap(part => {
    if (part.bodyView?.input !== "preview" || part.status !== "completed" || part.toolName !== "ApplyPatch") return []
    const facts = part.metadata.changedFiles as { files?: unknown[]; fileCount?: number; truncated?: boolean } | undefined
    return facts?.truncated === true && Array.isArray(facts.files) && Number.isSafeInteger(facts.fileCount)
      ? [{ id: part.id, shown: facts.files.length, total: facts.fileCount }] : []
  })
  const settledObservations = observations?.filter((observation) => observation.status !== "captured") ?? []
  const toolFiles = settledObservations.length > 0
    ? changedFiles.filter((file) => !settledObservations.some((observation) =>
      observation.repositoryRoot && isAbsoluteFileInRepository(file.path, observation.repositoryRoot)))
    : changedFiles
  if (parts.length === 0) return <span className="text-xs text-ui-muted">正在生成回复...</span>

  return (
    <div className="group/assistant min-w-0 space-y-3">
      {blocks.map((block, index) => {
        if (block.type === "tool-group") {
          return (
            <ContentEntrance
              key={block.id}
              animate={
                streaming && Boolean(initialPartIds && !initialPartIds.has(block.tools[0]!.id))
              }
            >
              <ToolActivityGroup tools={block.tools} />
            </ContentEntrance>
          )
        }
        if (block.type === "terminal") {
          return (
            <ContentEntrance
              key={block.id}
              animate={streaming && Boolean(initialPartIds && !initialPartIds.has(block.tool.id))}
            >
              <TerminalActivityCard
                payload={block.payload}
                active={isTerminalActivityActive(block, streaming && index === blocks.length - 1)}
                onOpenTerminal={onOpenTerminal}
              />
            </ContentEntrance>
          )
        }
        const unit = block.unit
        if (unit.type === "plugin-ui") {
          return (
            <PluginUiCard
              key={unit.id}
              instance={unit.instance}
              call={unit.call}
              result={unit.result}
            />
          )
        }
        if (unit.type === "agent") {
          return (
            <ContentEntrance
              key={unit.id}
              animate={streaming && Boolean(initialPartIds && !initialPartIds.has(unit.id))}
            >
              <AgentActivityMessage
                call={unit.call}
                result={unit.result}
                tasks={tasks}
                onOpenAgents={onOpenAgents}
              />
            </ContentEntrance>
          )
        }
        if (unit.type === "markdown") {
          return (
            <AssistantMarkdown
              key={unit.id}
              text={unit.text}
              phase={unit.phase}
              streaming={streaming && index === blocks.length - 1}
              animateInitialText={Boolean(initialPartIds && !initialPartIds.has(unit.id))}
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

      {!streaming && showObservations ? settledObservations.map((observation, index) => (
        observation.status === "unavailable" ? (
          observation.reason === "not_git_repository" ? null :
            <p key={index} className="text-xs text-ui-muted">运行期间变更无法确认：{workspaceChangeReason(observation.reason)}</p>
        ) : (
          <ChangedFilesSummary key={index} files={observation.files.map((file) => ({ path: file.path, additions: 0, deletions: 0, hasStats: false }))}
            observation={observation} canOpenReview={canOpenReview} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
        )
      )) : null}
      {!streaming && isTurnComplete(parts) && toolFiles.length > 0 ? (
        <ChangedFilesSummary
          files={toolFiles}
          canOpenReview={canOpenReview}
          onOpenFile={onOpenFile}
          onOpenReview={onOpenReview}
        />
      ) : null}
      {!streaming ? fileIdentityLimits.map(limit => <p key={limit.id} className="text-xs text-ui-muted">工具文件列表仅显示 {limit.shown} / {limit.total} 个文件。</p>) : null}
    </div>
  )
}

function AssistantMarkdown({
  text,
  phase,
  streaming,
  animateInitialText,
  onOpenFile,
}: {
  text: string
  phase?: "commentary" | "final_answer"
  streaming: boolean
  animateInitialText: boolean
  onOpenFile: (path: string, line?: number) => void
}): React.JSX.Element {
  const components = useMemo(() => createStreamdownComponents({ onOpenFile }), [onOpenFile])
  // 让 Streamdown 记住已有文字，重新打开进行中的回复时不重播历史。
  const [initialText] = useState(() => (animateInitialText ? "" : text))

  return (
    <div
      className="assistant-markdown min-w-0"
      data-phase={phase}
      data-stream-initial={streaming && text === initialText ? "true" : undefined}
    >
      <Streamdown
        className="desktop-streamdown space-y-0"
        animated={streamingTextAnimation}
        isAnimating={streaming}
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
  return isToolActivityActive(tool.call, tool.result)
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
  const text = toolOutputText(value)
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

function ToolDiagnosticDot({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      data-tool-diagnostic
      role="img"
      aria-label={label}
      title={label}
      className="size-1.5 shrink-0 rounded-full bg-amber-500/60 dark:bg-amber-400/60"
    />
  )
}

function generationSummary(tool: ToolUnit): { label: string; tooltip: string } {
  const progress = tool.call.metadata.toolProgress as { filePath?: string; receivedChars?: number }
  const path = typeof progress?.filePath === "string" ? progress.filePath : ""
  const displayPath = path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
  const name = summarizeToolCall(tool.call).name
  return {
    label: displayPath ? `${name} ${displayPath}` : name,
    tooltip: `${path ? `${path}；` : ""}已接收 ${progress?.receivedChars ?? 0} 字符；尚未开始执行`,
  }
}

function ToolGenerationIcon({ toolName }: { toolName?: string }): React.JSX.Element {
  return (
    <LoaderCircle
      role="img"
      aria-label={toolName === "Write" || toolName === "Edit"
        ? "正在生成文件内容，尚未开始执行"
        : "正在生成工具参数，尚未开始执行"}
      className="size-3.5 shrink-0 text-ui-muted motion-safe:animate-spin"
      strokeWidth={1.7}
    />
  )
}

function ToolActivityGroup({ tools }: { tools: ToolUnit[] }): React.JSX.Element {
  const groupTooltipId = useId()
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const grouped = tools.length > 1
  const active = tools.some(isToolInFlight)
  const activityLabel = toolGroupActivityLabel(tools)
  const counts = { edits: 0, commands: 0, reads: 0 }
  for (const tool of tools) {
    if (isToolGenerationPresentation(tool.call)) continue
    const name = tool.call.toolName ?? ""
    if (/bash|shell|terminal|exec|command/i.test(name)) counts.commands++
    else if (/write|edit|patch|create|delete/i.test(name)) counts.edits++
    else counts.reads++
  }
  const failures = import.meta.env.DEV
    ? tools.filter(
        (tool) =>
          !isToolGenerationPresentation(tool.call) &&
          toolCallStatus(tool.call, tool.result) === "failed"
      ).length
    : 0
  const activityHeading = [
    counts.edits ? `文件编辑 ${counts.edits} 次` : "",
    counts.commands ? `命令调用 ${counts.commands} 次` : "",
    counts.reads ? `工具查看 ${counts.reads} 次` : "",
  ]
    .filter(Boolean)
    .join("，")
  const generatingTools = tools.filter((tool) => isToolGenerationPresentation(tool.call))
  const heading = [
    activityHeading,
    !open ? generatingTools.map((tool) => generationSummary(tool).label).join("、") : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const diagnosticLabel = [
    failures ? `${failures} 次失败` : "",
    activityLabel && diagnosticToolLabels.has(activityLabel) ? activityLabel : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <section aria-label="工具活动组" className="text-ui-small text-ui-muted">
      {grouped ? (
        <Tooltip disabled={open || !generatingTools.length}>
          <TooltipTrigger
            aria-describedby={!open && generatingTools.length ? groupTooltipId : undefined}
            render={
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className={cn(
                  "flex h-7 max-w-full items-center gap-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  active && !generatingTools.length && "shimmer"
                )}
              />
            }
          >
            {!open && generatingTools.length ? (
              <ToolGenerationIcon toolName={generatingTools.length === 1 ? generatingTools[0]?.call.toolName : undefined} />
            ) : (
              <Pencil className="size-3.5 shrink-0" strokeWidth={1.7} />
            )}
            <span className="truncate">
              {heading || "工具活动"}
              {activityLabel &&
              !diagnosticToolLabels.has(activityLabel) &&
              !(generatingTools.length && activityLabel === "准备中")
                ? ` · ${activityLabel}`
                : ""}
            </span>
            {diagnosticLabel ? <ToolDiagnosticDot label={diagnosticLabel} /> : null}
            <ChevronDown
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
            />
          </TooltipTrigger>
          <TooltipContent id={groupTooltipId} role="tooltip" className="max-w-sm break-all">
            {generatingTools.map((tool) => generationSummary(tool).tooltip).join("；")}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {!grouped || open ? (
        <div className={cn("space-y-0.5", grouped && "mt-1 border-l border-border/70 pl-4")}>
          {tools.map((tool) => {
            if (isToolGenerationPresentation(tool.call))
              return (
                <Tooltip key={tool.id}>
                  <TooltipTrigger
                    aria-describedby={`tool-generation-hint-${tool.id}`}
                    render={
                      <div
                        tabIndex={0}
                        className="flex h-7 min-w-0 items-center gap-2 text-ui-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      />
                    }
                  >
                    <ToolGenerationIcon toolName={tool.call.toolName} />
                    <span className="min-w-0 truncate">{generationSummary(tool).label}</span>
                  </TooltipTrigger>
                  <TooltipContent
                    id={`tool-generation-hint-${tool.id}`}
                    role="tooltip"
                    className="max-w-sm break-all"
                  >
                    {generationSummary(tool).tooltip}
                  </TooltipContent>
                </Tooltip>
              )
            const summary = summarizeToolCall(tool.call)
            const active = activeId === tool.id
            const calling = isToolInFlight(tool)
            const input = tool.call.input
            const parseError =
              tool.result?.metadata.toolInputError ?? tool.call.metadata.toolInputError
            const unparsedInput = Boolean(
              parseError && (input === undefined || Object.keys(input).length === 0)
            )
            const detail =
              summary.detail ??
              (unparsedInput
                ? "查看详情"
                : tool.call.bodyView?.input === "preview"
                  ? "查看参数"
                : input === undefined
                  ? "参数尚未提供"
                  : Object.keys(input).length === 0
                    ? "无参数"
                    : "查看参数")
            const statusText = toolActivityLabel(tool.call, tool.result)
            return (
              <div key={tool.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(active ? null : tool.id)
                    // 单行详情已打开时，随后归组仍保留当前展开状态。
                    if (!grouped) setOpen(!active)
                  }}
                  aria-expanded={active}
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-2 text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    calling && "shimmer"
                  )}
                >
                  <TerminalSquare className="size-3.5 shrink-0" strokeWidth={1.6} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-ui-foreground">{summary.name}</span>
                    <span className="ml-1.5 text-ui-muted/80">{detail}</span>
                  </span>
                  {statusText ? (
                    diagnosticToolLabels.has(statusText) ? (
                      <ToolDiagnosticDot label={statusText} />
                    ) : (
                      <span className="shrink-0 text-xs text-ui-muted">{statusText}</span>
                    )
                  ) : null}
                  <ChevronDown
                    className={cn("size-3.5 shrink-0 transition-transform", active && "rotate-180")}
                  />
                </button>
                {active ? (
                  <div className="mb-2 overflow-hidden rounded-md border bg-muted/30">
                    <ToolDetails tool={tool} calling={calling} />
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

function ToolDetails({ tool, calling }: { tool: ToolUnit; calling: boolean }): React.JSX.Element {
  const { call, result } = tool
  const { call: fullCall, result: fullResult, preview, error } = useToolDetails(call, result, true)
  const input = fullCall.input
  const output = fullResult?.output ?? fullCall.output
  const unparsedInput = Boolean((fullResult?.metadata.toolInputError ?? fullCall.metadata.toolInputError) && (input === undefined || Object.keys(input).length === 0))
  return <>
    <div className="border-b px-3 py-1.5 text-xs">{toolDisplayName(call, result)}</div>
    {preview ? <p role="status" className="px-3 py-2 text-xs text-ui-muted">{error ?? "正在加载完整详情；当前仅显示预览。"}</p> : null}
    <div className="px-3 pt-2 text-xs font-medium">参数</div>
    {unparsedInput ? <p className="px-3 py-2 text-xs text-ui-muted">{import.meta.env.DEV ? "参数解析失败，请查看下方错误结果。" : "没有记录可展示的参数。"}</p>
      : input === undefined ? <p className="px-3 py-2 text-xs text-ui-muted">参数尚未提供</p>
        : <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">{formatValue(input)}</pre>}
    <div className="border-t px-3 pt-2 text-xs font-medium">结果</div>
    {output === undefined ? <p className="px-3 py-2 text-xs text-ui-muted">{calling ? "等待工具返回结果" : "没有记录结果"}</p>
      : <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">{formatValue(output)}</pre>}
    {preview && fullCall.bodyView?.outputReferences?.length ? <p className="px-3 py-2 text-xs text-ui-muted">{fullCall.bodyView.outputReferences.join("\n")}</p> : null}
  </>
}

export function ChangedFilesSummary({
  files,
  observation,
  canOpenReview,
  onOpenFile,
  onOpenReview,
}: {
  files: ChangedFile[]
  observation?: WorkspaceChangesMetadata
  canOpenReview: boolean
  onOpenFile: (path: string, line?: number) => void
  onOpenReview: (path?: string, scope?: DesktopGitDiffScope, rootPath?: string) => void
}): React.JSX.Element | null {
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectPath = observation?.repositoryRoot ?? workspaceProject?.path
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
      if (observation || !canOpenReview || !selectedProjectPath || files.length === 0) {
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
  }, [canOpenReview, fileKey, files.length, selectedProjectPath, observation])

  const filesWithStats = useMemo(
    () =>
      files.map((file) => {
        const stats = observation ? undefined :
          gitStatsByPath[
            normalizeReviewPath(toProjectRelativePath(file.path, selectedProjectPath) ?? file.path)
          ]
        return stats ? { ...file, ...stats, hasStats: true } : file
      }),
    [files, gitStatsByPath, selectedProjectPath, observation]
  )
  const visible = expanded ? filesWithStats : filesWithStats.slice(0, 3)
  const hasStats = filesWithStats.some((file) => file.hasStats)
  const statsFiles = hasStats ? filesWithStats.filter((file) => file.hasStats) : filesWithStats
  const additions = statsFiles.reduce((total, file) => total + file.additions, 0)
  const deletions = statsFiles.reduce((total, file) => total + file.deletions, 0)

  if ((observation?.fileCount ?? files.length) === 0) return null

  return (
    <section className="text-ui-small overflow-hidden rounded-lg border bg-transparent">
      <header className="flex min-h-15 items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted/75 text-ui-muted">
          <FileCode2 className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{observation ? `运行期间变更：仓库内 ${observation.fileCount} 个文件` : `已编辑 ${files.length} 个文件`}</h3>
          {observation ? <p className="mt-0.5 text-xs text-ui-muted">
            {observation.totalLines} 行变化{observation.truncated ? " · 摘要已截断" : ""} · 点击查看当前工作区差异
          </p> : null}
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
                ? observation ? onOpenReview(file.path, "uncommitted", selectedProjectPath) : onOpenReview(file.path)
                : onOpenFile(observation && selectedProjectPath ? `${selectedProjectPath.replace(/[\\/]$/, "")}/${file.path}` : file.path)
            }
            className="flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-ui-muted">{file.path}</span>
            {observation ? <span className="text-xs text-ui-muted">{observation.files.find((stored) => stored.path === file.path)?.lines ?? 0} 行变化</span> : file.hasStats ? (
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

function workspaceChangeReason(reason: WorkspaceChangesMetadata["reason"]): string {
  switch (reason) {
    case "preexisting_dirty_overlap": return "已有未提交文件在本轮又发生变化"
    case "concurrent_run_overlap": return "同一仓库有其他运行重叠"
    case "not_git_repository": return "当前目录不是 Git 仓库"
    case "execution_environment_unavailable": return "无法安全检查本轮的执行环境"
    case "observation_budget_exceeded": return "观察超过时间预算"
    case "observation_cancelled": return "观察已取消"
    case "sensitive_content_path": return "涉及敏感文件，未读取差异"
    case "non_linear_head_change": case "post_commit_worktree_changed": return "Git 提交或工作区状态无法安全比较"
    case "daemon_restarted": return "服务重启，基线已丢失"
    default: return "Git 检查失败"
  }
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
