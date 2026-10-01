import {
  Bot,
  ChevronDown,
  FileDiff,
  FileText,
  Link,
  ListFilter,
  Plus,
  RefreshCw,
} from "lucide-react"
import { useMemo, useState } from "react"

import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader } from "@renderer/components/ui/empty"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@renderer/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@renderer/components/ui/popover"
import { Separator } from "@renderer/components/ui/separator"
import { Spinner } from "@renderer/components/ui/spinner"
import type { DesktopProject, DesktopSessionView } from "@shared/session-types"
import type { DesktopGitDiffScope } from "@shared/git-types"

import {
  collectSessionSources,
  sessionChangesRevision,
  summarizeAgentTasks,
  type SessionSummarySource,
} from "./session-summary-model"
import { useSessionSummaryChanges } from "./use-session-summary-changes"

type SummaryProps = {
  view: DesktopSessionView | null
  workspace: DesktopProject | null
  canOpenReview: boolean
  onOpenReview: (path?: string, scope?: DesktopGitDiffScope) => void
  onOpenAgents: () => void
  onOpenFile: (path: string, line?: number) => void
  onPickFiles?: () => void
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
}: SummaryProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
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
      onOpenChange={(next) => {
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
        className="w-88 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-2xl p-4"
      >
        <PopoverTitle className="truncate" title={workspace?.path ?? view?.session.cwd}>
          {name}
        </PopoverTitle>
        <PopoverDescription className="sr-only">查看当前聊天的工作摘要。</PopoverDescription>

        {canOpenReview ? (
          <>
            <section aria-label="工作区变更" className="flex flex-col gap-2 py-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">工作区变更 · 未提交</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="刷新工作区变更"
                  title="刷新工作区变更"
                  disabled={changes.status === "loading"}
                  onClick={changes.refresh}
                >
                  <RefreshCw />
                </Button>
              </div>
              {changes.status === "loading" ? (
                <div
                  role="status"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Spinner />
                  正在读取变更…
                </div>
              ) : changes.status === "error" ? (
                <Alert variant="destructive">
                  <AlertDescription>{changes.error}</AlertDescription>
                </Alert>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start py-2"
                  aria-label="查看工作区未提交变更"
                  onClick={() => {
                    setOpen(false)
                    onOpenReview(undefined, "uncommitted")
                  }}
                >
                  <FileDiff data-icon="inline-start" />
                  <span className="flex-1 text-left">
                    {changes.result.files.length
                      ? `${changes.result.files.length} 个文件`
                      : "暂无变更"}
                  </span>
                  <span className="flex gap-2 font-mono tabular-nums">
                    <span className="text-diff-addition">
                      +{changes.result.totalAdditions.toLocaleString()}
                    </span>
                    <span className="text-destructive">
                      −{changes.result.totalDeletions.toLocaleString()}
                    </span>
                  </span>
                </Button>
              )}
            </section>
            <Separator />
          </>
        ) : null}

        <section aria-label="聊天子智能体" className="flex flex-col gap-2 py-4">
          <span className="text-xs text-muted-foreground">子智能体</span>
          {agents.total ? (
            <Button
              type="button"
              variant="ghost"
              aria-label="查看聊天子智能体"
              className="h-auto w-full justify-start py-2"
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
          ) : (
            <p className="text-xs text-muted-foreground">暂无</p>
          )}
        </section>
        <Separator />

        <section aria-label="资料来源" className="flex min-h-0 flex-col gap-2 pt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              资料来源{sources.length ? ` · ${sources.length}` : ""}
            </span>
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
          {sources.length ? (
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
                  className="flex-nowrap text-left hover:bg-muted"
                >
                  <ItemMedia variant="icon" className="text-muted-foreground">
                    {source.kind === "url" ? <Link /> : <FileText />}
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="max-w-full truncate">{source.label}</ItemTitle>
                    <ItemDescription>
                      {source.origin === "provided"
                        ? "用户提供"
                        : source.origin === "search"
                          ? "搜索结果"
                          : "已读取"}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <Empty className="p-2">
              <EmptyHeader>
                <EmptyDescription>暂无</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
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
      </PopoverContent>
    </Popover>
  )
}
