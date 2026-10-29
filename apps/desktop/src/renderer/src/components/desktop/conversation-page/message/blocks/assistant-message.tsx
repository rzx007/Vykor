import { AlertCircle, ChevronDown, FileCode2, LoaderCircle, TerminalSquare } from "lucide-react"
import { memo, useEffect, useId, useMemo, useState } from "react"
import type { WorkspaceChangesMetadata } from "@rzx/client"
import type { DesktopGitDiffScope } from "@shared/git-types"

import { Button } from "@renderer/components/ui/button"
import { LoadingState } from "@renderer/components/ui/loading-state"
import { AttachmentGroup } from "@renderer/components/ui/attachment"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { queryGitChanges } from "@renderer/lib/git-changes-query"
import { cn } from "@renderer/lib/utils"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import {
  isAbsoluteFileInRepository,
  routeChangedFileClick,
  toProjectRelativePath,
} from "@shared/workspace-open-path"

import {
  buildAssistantContent,
  collectChangedFiles,
  isTurnComplete,
  summarizeToolCall,
  toolCallStatus,
  toolActivityLabel,
  toolGroupActivityLabel,
  toolGroupInlineStatus,
  isToolActivityActive,
  type AssistantContentUnit,
  type ChangedFile,
} from "../models/message-render-model"
import { AssistantMarkdown } from "../markdown/assistant-markdown"
import { truncateReasoning } from "../models/reasoning-text"
import { MessageAttachment } from "../attachments/message-attachment"
import { GeneratedImageGallery, ImageGenerationMessage } from "../attachments/image-generation-message"
import { ContentEntrance } from "./content-entrance"
import { AgentActivityMessage } from "../activity/agent-activity-message"
import { toolOutputText } from "../models/message-content"
import { isToolGenerationPresentation } from "../activity/tool-generation-presentation"
import { readImagePath } from "../attachments/read-image-preview"
import { ToolDetails } from "../tool-details"
import { useConversationScroller } from "../../transcript/conversation-scroll-context"
import { WorkflowSummary } from "../../../tools/workflows/workflow-summary"
import { ReadToolRow } from "../tool-details/read-tool-row"
import { readFileReference } from "../tool-details/read-tool-model"
import { PluginUiHistoryCard } from "../tool-details/plugin-ui-history-card"
import { PluginAppToolResultEntry } from "../../../shell/plugin-apps/tool-result-entry"
import { TerminalActivityCard, type TerminalActivityInfo } from "../activity/terminal-activity-card"

const emptyAgentTasks: DesktopSessionTask[] = []
const diagnosticToolLabels = new Set(["失败", "已中断", "结果不确定", "工具失败，等待本轮结果"])

type ChangedFileStats = {
  additions: number
  deletions: number
}

type AssistantMessageProps = {
  parts: DesktopSessionPart[]
  summaryParts?: DesktopSessionPart[]
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
}

export const AssistantMessage = memo(function AssistantMessage({
  parts,
  summaryParts = parts,
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
}: AssistantMessageProps): React.JSX.Element {
  const units = useMemo(() => buildAssistantContent(parts), [parts])
  const blocks = useMemo(() => groupToolUnits(units), [units])
  const changedFiles = useMemo(() => collectChangedFiles(summaryParts), [summaryParts])
  const fileIdentityLimits = summaryParts.flatMap((part) => {
    if (
      part.bodyView?.input !== "preview" ||
      part.status !== "completed" ||
      part.toolName !== "ApplyPatch"
    )
      return []
    const facts = part.metadata.changedFiles as
      { files?: unknown[]; fileCount?: number; truncated?: boolean } | undefined
    return facts?.truncated === true &&
      Array.isArray(facts.files) &&
      Number.isSafeInteger(facts.fileCount)
      ? [{ id: part.id, shown: facts.files.length, total: facts.fileCount }]
      : []
  })
  const settledObservations =
    observations?.filter((observation) => observation.status !== "captured") ?? []
  // 单个卡片同时承载「运行期观测到的仓库改动」和「仓库外被编辑的文件」。
  const observation = settledObservations.find((entry) => entry.status === "complete")
  const observedFiles: ChangedFile[] = (observation?.files ?? []).map((file) => ({
    path: file.path,
    additions: 0,
    deletions: 0,
    hasStats: false,
  }))
  const toolFiles =
    settledObservations.length > 0
      ? changedFiles.filter(
          (file) =>
            !settledObservations.some(
              (entry) =>
                entry.repositoryRoot && isAbsoluteFileInRepository(file.path, entry.repositoryRoot)
            )
        )
      : changedFiles
  const changedFileList = [...observedFiles, ...toolFiles]
  if (parts.length === 0) return <span className="text-xs text-ui-muted">正在生成回复...</span>

  return (
    <div className="group/assistant min-w-0 space-y-4">
      {parts.filter(part => part.metadata.pluginAppSource).map(part => <PluginAppToolResultEntry key={`app:${part.id}`} part={part} />)}
      {blocks.map((block, index) => {
        if (block.type === "tool-group") {
          return (
            <ContentEntrance
              key={block.id}
              animate={
                streaming && Boolean(initialPartIds && !initialPartIds.has(block.tools[0]!.id))
              }
            >
              <ToolActivityGroup tools={block.tools} onOpenFile={onOpenFile} />
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
                terminal={block.payload.terminal!}
                active={isToolInFlight(block.tool)}
                onOpenTerminal={onOpenTerminal}
              />
            </ContentEntrance>
          )
        }
        const unit = block.unit
        if (unit.type === "workflow") {
          return <WorkflowSummary key={unit.id} call={unit.call} result={unit.result} />
        }
        if (unit.type === "plugin-ui") {
          return (
            <PluginUiHistoryCard
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

      {!streaming &&
      showObservations &&
      isTurnComplete(summaryParts) &&
      changedFileList.length > 0 ? (
        <ChangedFilesSummary
          files={changedFileList}
          observation={observation}
          canOpenReview={canOpenReview}
          onOpenFile={onOpenFile}
          onOpenReview={onOpenReview}
        />
      ) : null}
      {!streaming && showObservations
        ? fileIdentityLimits.map((limit) => (
            <p key={limit.id} className="text-xs text-ui-muted">
              工具文件列表仅显示 {limit.shown} / {limit.total} 个文件。
            </p>
          ))
        : null}
    </div>
  )
}, areAssistantMessagePropsEqual)

function areAssistantMessagePropsEqual(
  previous: AssistantMessageProps,
  next: AssistantMessageProps
): boolean {
  const previousShowsObservations = previous.showObservations ?? true
  const nextShowsObservations = next.showObservations ?? true

  return (
    previous.streaming === next.streaming &&
    previousShowsObservations === nextShowsObservations &&
    previous.initialPartIds === next.initialPartIds &&
    previous.onOpenAgents === next.onOpenAgents &&
    previous.onOpenFile === next.onOpenFile &&
    previous.canOpenReview === next.canOpenReview &&
    previous.onOpenReview === next.onOpenReview &&
    previous.onOpenTerminal === next.onOpenTerminal &&
    sameReferences(previous.parts, next.parts) &&
    sameReferences(previous.summaryParts ?? previous.parts, next.summaryParts ?? next.parts) &&
    sameReferences(previous.tasks ?? emptyAgentTasks, next.tasks ?? emptyAgentTasks) &&
    (!previousShowsObservations || sameReferences(previous.observations, next.observations))
  )
}

function sameReferences<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined
): boolean {
  if (previous === next) return true
  if (!previous || !next || previous.length !== next.length) return false
  return previous.every((item, index) => item === next[index])
}

type ToolUnit = Extract<AssistantContentUnit, { type: "tool" }>
type ContentBlock =
  | { id: string; type: "unit"; unit: Exclude<AssistantContentUnit, ToolUnit> }
  | { id: string; type: "tool-group"; tools: ToolUnit[] }
  | { id: string; type: "terminal"; payload: TerminalToolPayload; tool: ToolUnit }

function isToolInFlight(tool: ToolUnit): boolean {
  return isToolActivityActive(tool.call, tool.result)
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
  terminal?: TerminalActivityInfo
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
      aria-label={
        toolName === "Write" || toolName === "Edit"
          ? "正在生成文件内容，尚未开始执行"
          : "正在生成工具参数，尚未开始执行"
      }
      className="size-3.5 shrink-0 text-ui-muted motion-safe:animate-spin"
      strokeWidth={1.7}
    />
  )
}

function ToolActivityGroup({
  tools,
  onOpenFile,
}: {
  tools: ToolUnit[]
  onOpenFile: (path: string, line?: number) => void
}): React.JSX.Element {
  const groupTooltipId = useId()
  const expansion = useConversationScroller()?.turnExpansion
  const groupKey = `tool-group:${tools[0]!.id}`
  const [open, setOpen] = useState(() => expansion?.get(groupKey) ?? false)
  const [activeId, setActiveId] = useState<string | null>(
    () =>
      tools.find((tool) => !readImagePath(tool.call) && expansion?.get(`tool:${tool.id}`))?.id ??
      null
  )
  const [expandedImages, setExpandedImages] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        tools
          .filter((tool) => readImagePath(tool.call) && expansion?.get(`tool:${tool.id}`))
          .map((tool) => tool.id)
      )
  )
  const changeOpen = (value: boolean) => {
    expansion?.set(groupKey, value)
    setOpen(value)
  }
  const toggleTool = (id: string, active: boolean, image: boolean) => {
    expansion?.set(`tool:${id}`, !active)
    if (image)
      setExpandedImages((previous) => {
        const next = new Set(previous)
        if (active) next.delete(id)
        else next.add(id)
        return next
      })
    else {
      if (activeId && activeId !== id) expansion?.set(`tool:${activeId}`, false)
      setActiveId(active ? null : id)
    }
    // 单行详情打开后追加相邻工具时，保留当前展开。
    if (tools.length === 1) changeOpen(!active)
  }
  const grouped = tools.length > 1
  const status = toolGroupInlineStatus(tools)
  const activityLabel = import.meta.env.DEV ? toolGroupActivityLabel(tools) : undefined
  const failures = import.meta.env.DEV
    ? tools.filter(
        (tool) =>
          !isToolGenerationPresentation(tool.call) &&
          toolCallStatus(tool.call, tool.result) === "failed"
      ).length
    : 0
  const generatingTools = tools.filter((tool) => isToolGenerationPresentation(tool.call))
  const diagnosticLabel = [
    failures ? `${failures} 次失败` : "",
    activityLabel && diagnosticToolLabels.has(activityLabel) ? activityLabel : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <section aria-label="工具活动组" className="text-chat text-ui-muted">
      {grouped ? (
        <Tooltip disabled={open || !generatingTools.length}>
          <TooltipTrigger
            aria-describedby={!open && generatingTools.length ? groupTooltipId : undefined}
            render={
              <button
                type="button"
                onClick={() => changeOpen(!open)}
                aria-expanded={open}
                className="flex min-h-7 max-w-full items-center gap-2 text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              />
            }
          >
            <LoadingState
              label={status.label}
              state={status.orb}
              size={20}
              showElapsed={false}
              showIndicator={status.active}
              paused={!status.active}
              className="gap-2 text-[length:inherit] font-normal"
            />
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
                        className="flex min-h-7 min-w-0 items-center gap-2 text-ui-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
            const imagePath = readImagePath(tool.call)
            const active = imagePath ? expandedImages.has(tool.id) : activeId === tool.id
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
            const file = readFileReference(tool.call, tool.result)
            return (
              <div key={tool.id}>
                {file ? (
                  <ReadToolRow
                    call={tool.call}
                    result={tool.result}
                    file={file}
                    active={active}
                    calling={calling}
                    onOpenFile={onOpenFile}
                    onToggle={() => toggleTool(tool.id, active, false)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleTool(tool.id, active, Boolean(imagePath))}
                    aria-expanded={active}
                    className={cn(
                      "group/tool-row flex min-h-7 w-full min-w-0 items-center gap-2 text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      calling && "shimmer"
                    )}
                  >
                    <TerminalSquare className="size-3.5 shrink-0" strokeWidth={1.6} />
                    <span className="min-w-0 truncate">
                      <span className="text-ui-foreground">{summary.name}</span>
                      <span className="ml-1.5 text-ui-muted">{detail}</span>
                    </span>
                    {statusText ? (
                      diagnosticToolLabels.has(statusText) ? (
                        <ToolDiagnosticDot label={statusText} />
                      ) : (
                        <span className="shrink-0 text-ui-muted">{statusText}</span>
                      )
                    ) : null}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 shrink-0 opacity-0 transition-[opacity,transform] group-hover/tool-row:opacity-100 group-focus-visible/tool-row:opacity-100 motion-reduce:transition-none",
                        active && "rotate-180"
                      )}
                    />
                  </button>
                )}
                {active ? (
                  <div className="mb-2 overflow-hidden rounded-md border bg-muted/30">
                    {file ? (
                      <p className="border-b px-3 py-2 text-xs text-ui-muted">
                        当时的读取结果；文件面板显示当前内容。
                      </p>
                    ) : null}
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
  const mergedFiles = useMemo(
    () => mergeChangedFileLists(files, selectedProjectPath),
    [files, selectedProjectPath]
  )
  const fileKey = useMemo(
    () =>
      mergedFiles
        .map((file) => {
          const path = changedFilePathKey(file.path, selectedProjectPath)
          return `${path}:${file.additions}:${file.deletions}:${file.hasStats ? "stats" : "patch"}`
        })
        .join("\n"),
    [mergedFiles, selectedProjectPath]
  )
  // 运行期已记录增删拆分的文件直接用它，提交后仍能显示 +/-。
  const observedStats = useMemo(() => {
    const stats = new Map<string, ChangedFileStats>()
    for (const file of observation?.files ?? []) {
      if (file.additions === undefined || file.deletions === undefined) continue
      stats.set(changedFilePathKey(file.path, selectedProjectPath), {
        additions: file.additions,
        deletions: file.deletions,
      })
    }
    return stats
  }, [observation, selectedProjectPath])
  const needsGitStats = mergedFiles.some(
    (file) => !observedStats.has(changedFilePathKey(file.path, selectedProjectPath))
  )

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!canOpenReview || !selectedProjectPath || !needsGitStats) {
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
  }, [canOpenReview, fileKey, needsGitStats, selectedProjectPath])

  const observedPaths = useMemo(
    () =>
      new Set(
        (observation?.files ?? []).map((file) => changedFilePathKey(file.path, selectedProjectPath))
      ),
    [observation, selectedProjectPath]
  )

  const filesWithStats = useMemo(
    () =>
      mergedFiles.map((file) => {
        const key = changedFilePathKey(file.path, selectedProjectPath)
        const stats = observedStats.get(key) ?? gitStatsByPath[key]
        // 二进制、仅改权限等没有文本行变化的改动不显示 +/-。
        if (!stats || (stats.additions === 0 && stats.deletions === 0)) return file
        return { ...file, ...stats, hasStats: true }
      }),
    [mergedFiles, observedStats, gitStatsByPath, selectedProjectPath]
  )
  // 只在运行期没有记录拆分时，才回退显示记录的总行数。
  const storedLinesByPath = useMemo(() => {
    const lines = new Map<string, number>()
    for (const file of observation?.files ?? []) {
      if (file.additions !== undefined && file.deletions !== undefined) continue
      lines.set(changedFilePathKey(file.path, selectedProjectPath), file.lines)
    }
    return lines
  }, [observation, selectedProjectPath])

  const statsFiles = filesWithStats.filter((file) => file.hasStats)
  const additions = statsFiles.reduce((total, file) => total + file.additions, 0)
  const deletions = statsFiles.reduce((total, file) => total + file.deletions, 0)
  // 只有仓库内文件能进入 diff 审阅；全是仓库外文件时不提供入口。
  const hasReviewableFile = filesWithStats.some(
    (file) => routeChangedFileClick(file.path, selectedProjectPath, true) === "review"
  )
  const observedListed = filesWithStats.filter((file) =>
    observedPaths.has(changedFilePathKey(file.path, selectedProjectPath))
  ).length
  const totalCount =
    filesWithStats.length + Math.max(0, (observation?.fileCount ?? 0) - observedListed)

  if (totalCount === 0) return null

  return (
    <section
      aria-label="文件编辑摘要"
      className="text-ui-small overflow-hidden rounded-lg border bg-transparent"
    >
      <header className="flex min-h-15 items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted/75 text-ui-muted">
          <FileCode2 className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            已编辑 {totalCount} 个文件
            {observation?.truncated ? (
              <span className="font-normal text-ui-muted"> · 摘要已截断</span>
            ) : null}
          </h3>
          {statsFiles.length > 0 ? (
            <p className="mt-0.5 font-mono tabular-nums">
              <span className="text-diff-addition">+{additions}</span>{" "}
              <span className="text-destructive">-{deletions}</span>
            </p>
          ) : null}
        </div>
        {canOpenReview && selectedProjectPath && hasReviewableFile ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            shape="pill"
            onClick={() => onOpenReview(undefined, "uncommitted", selectedProjectPath)}
          >
            查看变更
          </Button>
        ) : null}
      </header>
      <div className="border-t">
        {(expanded ? filesWithStats : filesWithStats.slice(0, 3)).map((file) => {
          const storedLines = storedLinesByPath.get(
            changedFilePathKey(file.path, selectedProjectPath)
          )
          return (
            <button
              key={file.path}
              type="button"
              onClick={() =>
                routeChangedFileClick(file.path, selectedProjectPath, canOpenReview) === "review"
                  ? observation
                    ? onOpenReview(file.path, "uncommitted", observation.repositoryRoot)
                    : onOpenReview(file.path)
                  : onOpenFile(
                      selectedProjectPath && !isAbsoluteChangedPath(file.path)
                        ? `${selectedProjectPath.replace(/[\\/]$/, "")}/${file.path}`
                        : file.path
                    )
              }
              title={file.path}
              className="flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-ui-muted">{file.path}</span>
              {file.hasStats ? (
                <LineStats additions={file.additions} deletions={file.deletions} />
              ) : storedLines !== undefined ? (
                <span className="shrink-0 text-xs text-ui-muted">{storedLines} 行变化</span>
              ) : null}
            </button>
          )
        })}
      </div>
      {!expanded && filesWithStats.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-9 items-center gap-2 px-3 font-medium text-ui-muted hover:text-foreground"
        >
          再显示 {filesWithStats.length - 3} 个文件 <ChevronDown className="size-3.5" />
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
      <span className="text-diff-addition">+{additions}</span>
      <span className="ml-1 text-destructive">-{deletions}</span>
    </span>
  )
}

function normalizeReviewPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase()
}

function changedFilePathKey(path: string, projectPath: string | undefined): string {
  return normalizeReviewPath(toProjectRelativePath(path, projectPath) ?? path)
}

/** 同一文件可能既出现在运行期观测里，又出现在工具入参里；按路径合并并保留行数统计。 */
function mergeChangedFileLists(
  files: ChangedFile[],
  projectPath: string | undefined
): ChangedFile[] {
  const merged = new Map<string, ChangedFile>()
  for (const file of files) {
    const key = changedFilePathKey(file.path, projectPath)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, file)
      continue
    }
    merged.set(key, {
      path: existing.path,
      additions: existing.hasStats ? existing.additions : file.additions,
      deletions: existing.hasStats ? existing.deletions : file.deletions,
      hasStats: existing.hasStats || file.hasStats,
    })
  }
  return [...merged.values()]
}

function isAbsoluteChangedPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/")
}
