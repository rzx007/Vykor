import {
  Bot,
  ChevronDown,
  FileDiff,
  FileText,
  Link,
  ListFilter,
  Plus,
  RefreshCw,
  X,
  PanelsTopLeft,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@renderer/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@renderer/components/ui/popover"
import type { DesktopProject, DesktopSessionView } from "@shared/session-types"
import type { DesktopGitDiffScope } from "@shared/git-types"

import {
  collectSessionSources,
  sessionChangesRevision,
  summarizeAgentTasks,
  type SessionSummarySource,
} from "./session-summary-model"
import { useSessionSummaryChanges } from "./use-session-summary-changes"
import {
  usePluginAppConfirming,
  usePluginAppPages,
  usePluginApps,
} from "../../shell/plugin-apps/provider"
import { useWorkflows } from "../../tools/workflows/workflow-provider"
import { useSessionSummaryTerminals } from "./use-session-summary-terminals"
import { SessionSummaryAttention } from "./session-summary-attention"
import { SessionSummaryWork } from "./session-summary-work"

type SummaryProps = {
  view: DesktopSessionView | null
  workspace: DesktopProject | null
  canOpenReview: boolean
  onOpenReview: (path?: string, scope?: DesktopGitDiffScope) => void
  onOpenAgents: () => void
  onOpenFile: (path: string, line?: number) => void
  onPickFiles?: () => void
  onOpenApps?: () => void
  onOpenTerminal?: (id: string) => void
}

export function SessionSummaryPopover(props: SummaryProps): React.JSX.Element {
  // Reset the popup and requests together when switching conversations/workspaces.
  return <SessionSummary key={`${props.view?.session.id}:${props.workspace?.path}`} {...props} />
}

function SessionSummary({
  view,
  workspace,
  canOpenReview,
  onOpenReview,
  onOpenAgents,
  onOpenFile,
  onPickFiles,
  onOpenApps,
  onOpenTerminal,
}: SummaryProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [automatic, setAutomatic] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const manager = usePluginApps()
  const confirming = usePluginAppConfirming()
  const allPages = usePluginAppPages()
  const pages = allPages.filter(
    (page) => page.controller.state.source.sessionId === view?.session.id
  )
  const workflows = useWorkflows()
  const workflow = workflows?.sessionId === view?.session.id ? workflows : null
  const runs = workflow?.snapshot?.runs ?? []
  const shellTasks =
    view?.tasks.filter((task) => task.sessionId === view.session.id && task.type === "shell") ?? []
  const sessionRuns = view?.runs.filter((run) => run.sessionId === view.session.id) ?? []
  const latestRun =
    sessionRuns.find((run) => run.status === "running") ??
    sessionRuns.reduce<(typeof sessionRuns)[number] | undefined>(
      (latest, run) => (!latest || run.createdAt >= latest.createdAt ? run : latest),
      undefined
    )
  const currentRunIds = new Set(
    sessionRuns
      .filter(
        (run) =>
          latestRun &&
          (run.id === latestRun.id || (latestRun.inputId && run.inputId === latestRun.inputId))
      )
      .map((run) => run.id)
  )
  const currentMessageIds = new Set(
    view?.messages
      .filter(
        (message) =>
          message.sessionId === view.session.id && message.runId && currentRunIds.has(message.runId)
      )
      .map((message) => message.id)
  )
  const currentToolRequests = new Set(
    view?.parts
      .filter(
        (part) =>
          part.sessionId === view.session.id &&
          currentMessageIds.has(part.messageId) &&
          part.toolUseId
      )
      .map((part) => `tool:${part.toolUseId}`)
  )
  const currentTaskIds = new Set(
    shellTasks
      .filter((task) =>
        task.runId
          ? currentRunIds.has(task.runId)
          : task.requestNamespace === "tool" &&
            task.requestId &&
            currentToolRequests.has(task.requestId)
      )
      .map((task) => task.id)
  )
  const terminals = useSessionSummaryTerminals(view)
  const [attention] = useState(
    () =>
      new SessionSummaryAttention(
        Date.now(),
        pages.map((page) => `app:${page.controller.state.source.appId}`)
      )
  )
  const attentionItems = [
    ...pages.map((page) => ({ key: `app:${page.controller.state.source.appId}` })),
    ...runs.map((run) => ({ key: `workflow:${run.id}`, startedAt: run.startedAt })),
    ...terminals.records.map((terminal) => ({
      key: `terminal:${terminal.id}`,
      startedAt: Date.parse(terminal.createdAt),
    })),
    ...shellTasks.map((task) => ({ key: `shell:${task.id}`, startedAt: task.createdAt })),
  ]
  const attentionRevision = JSON.stringify(attentionItems)
  useEffect(() => {
    if (confirming) return
    let current = true
    queueMicrotask(() => {
      if (current && attention.observe(attentionItems) && !open) {
        setAutomatic(true)
        setOpen(true)
      }
    })
    return () => {
      current = false
    }
    // Only new identities matter. Streaming output and normal status refreshes cannot reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention, attentionRevision, confirming, open])
  const navigate = (action: () => void) => {
    setOpen(false)
    action()
  }
  const sources = useMemo(() => (open && view ? collectSessionSources(view) : []), [open, view])
  const agents = useMemo(() => summarizeAgentTasks(view?.tasks ?? []), [view?.tasks])
  const revision = open && view ? sessionChangesRevision(view) : ""
  const changes = useSessionSummaryChanges({
    open,
    rootPath: workspace?.path,
    enabled: canOpenReview,
    revision,
  })
  const name =
    workspace?.name ||
    view?.session.cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ||
    "当前聊天"
  const visibleSources = showAll ? sources : sources.slice(0, 3)

  const openSource = async (source: SessionSummarySource): Promise<void> => {
    setSourceError(null)
    try {
      if (source.kind === "file") onOpenFile(source.path)
      else if (source.kind === "url") await window.desktop.window.openExternal(source.url)
      else await window.desktop.attachments.open({ assetId: source.assetId })
      setOpen(false)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Popover
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (next) setAutomatic(false)
        setOpen(next)
        if (!next) setShowAll(false)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="当前聊天的工作摘要"
            title="当前聊天的工作摘要"
            disabled={!view}
            className="text-muted-foreground"
          />
        }
      >
        <ListFilter />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        initialFocus={automatic ? false : undefined}
        finalFocus={automatic ? false : undefined}
        className="max-h-[min(42rem,calc(100vh-5rem))] w-84 max-w-[calc(100vw-2rem)] scrollbar-thin gap-0 overflow-y-auto rounded-2xl p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <PopoverTitle
            className="min-w-0 truncate text-xs font-normal text-muted-foreground"
            title={workspace?.path ?? view?.session.cwd}
          >
            {name}
          </PopoverTitle>
          <div className="flex shrink-0 items-center gap-1">
            {onOpenApps && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="打开应用"
                title="打开应用"
                onClick={() => navigate(onOpenApps)}
              >
                <PanelsTopLeft />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="收起工作摘要"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </div>
        </div>
        <PopoverDescription className="sr-only">查看当前聊天的工作摘要。</PopoverDescription>

        <div className="divide-y divide-border/60 [&>section:last-child]:pb-0">
          {canOpenReview &&
          (changes.status === "error" ||
            (changes.status === "ready" && changes.result.files.length > 0)) ? (
            <section aria-label="工作区变更" className="flex flex-col gap-1 py-3">
              <div className="flex items-center justify-between gap-2">
                {changes.status === "error" ? (
                  <span className="text-xs text-muted-foreground">变更</span>
                ) : null}
                {changes.status === "ready" && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-8 min-w-0 flex-1 justify-start px-1.5 py-1.5 font-normal"
                    aria-label="查看工作区未提交变更"
                    onClick={() => navigate(() => onOpenReview(undefined, "uncommitted"))}
                  >
                    <FileDiff data-icon="inline-start" />
                    <span className="flex-1 text-left">变更</span>
                    <span className="flex gap-1.5 text-xs tabular-nums">
                      {changes.result.totalAdditions > 0 && (
                        <span className="text-diff-addition">
                          +{changes.result.totalAdditions.toLocaleString()}
                        </span>
                      )}
                      {changes.result.totalDeletions > 0 && (
                        <span className="text-destructive">
                          −{changes.result.totalDeletions.toLocaleString()}
                        </span>
                      )}
                    </span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="刷新工作区变更"
                  title="刷新工作区变更"
                  onClick={changes.refresh}
                >
                  <RefreshCw />
                </Button>
              </div>
              {changes.status === "error" ? (
                <Alert variant="destructive">
                  <AlertDescription>{changes.error}</AlertDescription>
                </Alert>
              ) : null}
            </section>
          ) : null}

          <SessionSummaryWork
            pages={pages}
            runs={runs}
            terminals={terminals.records}
            shellTasks={shellTasks}
            currentTaskIds={currentTaskIds}
            terminalError={terminals.error}
            workflowError={workflow?.error}
            workflowReconnecting={workflow?.syncStatus === "reconnecting"}
            onOpenApp={(page) => navigate(() => manager?.focus(page))}
            onOpenWorkflow={(id) => navigate(() => workflow?.open(id))}
            onOpenTerminal={onOpenTerminal ? (id) => navigate(() => onOpenTerminal(id)) : undefined}
          />

          {agents.total > 0 && (
            <section aria-label="聊天子智能体" className="flex flex-col gap-1 py-3">
              <span className="text-xs text-muted-foreground">子智能体</span>
              <Button
                type="button"
                variant="ghost"
                aria-label="查看聊天子智能体"
                className="h-auto min-h-8 w-full justify-start px-1.5 py-1.5 font-normal"
                onClick={() => {
                  setOpen(false)
                  onOpenAgents()
                }}
              >
                <Bot data-icon="inline-start" />
                <span className="flex flex-1 flex-wrap gap-x-3 gap-y-1 text-left text-xs">
                  {agents.active ? <span>{agents.active} 运行中</span> : null}
                  {agents.completed ? <span>{agents.completed} 完成</span> : null}
                  {agents.failed ? (
                    <span className="text-destructive">{agents.failed} 失败</span>
                  ) : null}
                  {agents.stopped ? (
                    <span className="text-muted-foreground">{agents.stopped} 已停止</span>
                  ) : null}
                </span>
                <ChevronDown data-icon="inline-end" className="-rotate-90" />
              </Button>
            </section>
          )}

          {(sources.length > 0 || sourceError) && (
            <section aria-label="资料来源" className="flex min-h-0 flex-col gap-1 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">来源</span>
                {onPickFiles ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="添加资料到输入框"
                    title="添加资料到输入框，发送后计入来源"
                    onClick={() => {
                      setOpen(false)
                      onPickFiles()
                    }}
                  >
                    <Plus />
                  </Button>
                ) : null}
              </div>
              {sourceError ? (
                <Alert variant="destructive">
                  <AlertDescription>{sourceError}</AlertDescription>
                </Alert>
              ) : null}
              <ItemGroup className="max-h-64 scrollbar-thin gap-0 overflow-y-auto">
                {visibleSources.map((source) => (
                  <Item
                    key={source.id}
                    size="xs"
                    data-summary-source
                    render={
                      <button
                        type="button"
                        aria-label={`打开资料 ${source.label}`}
                        onClick={() => void openSource(source)}
                      />
                    }
                    title={
                      source.kind === "file"
                        ? source.path
                        : source.kind === "url"
                          ? source.url
                          : source.label
                    }
                    className="min-h-8 flex-nowrap px-1.5 py-1.5 text-left text-muted-foreground hover:bg-muted"
                  >
                    <ItemMedia variant="icon" className="text-muted-foreground">
                      {source.kind === "url" ? <Link /> : <FileText />}
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full truncate text-xs font-normal">
                        {source.label}
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
              {sources.length > 3 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  onClick={() => setShowAll((current) => !current)}
                >
                  <ChevronDown
                    data-icon="inline-start"
                    className={showAll ? "rotate-180" : undefined}
                  />
                  {showAll ? "收起来源" : `查看全部 ${sources.length} 项`}
                </Button>
              ) : null}
            </section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
