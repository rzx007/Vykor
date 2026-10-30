import { useId, useState } from "react"
import { AlertCircle, ChevronDown, Clock3, CornerDownRight, X } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible"
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from "@renderer/components/ui/item"
import { Spinner } from "@renderer/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import type {
  PendingPromptSubmission,
  QueuedPromptAction,
} from "@renderer/stores/desktop-session/types"
import type { DesktopSessionInput, DesktopSessionRun } from "@shared/session-types"

interface PendingPrompt {
  input: DesktopSessionInput
  run: DesktopSessionRun
  action?: Pick<QueuedPromptAction, "kind" | "phase" | "error">
}

type LocalPendingSubmission = Pick<
  PendingPromptSubmission,
  "id" | "sessionId" | "content" | "phase" | "placement" | "error" | "dismissed"
>

export function PendingPromptQueue({
  prompts,
  activeRunId,
  localSubmissions = [],
  onPromote,
  onCancel,
  onDismissLocal = () => {},
  onRetryLocal,
}: {
  prompts: PendingPrompt[]
  activeRunId?: string
  localSubmissions?: LocalPendingSubmission[]
  onPromote: (inputId: string, queuedRunId: string) => void
  onCancel: (inputId: string, queuedRunId: string) => void
  onDismissLocal?: (inputId: string) => void
  onRetryLocal?: (inputId: string) => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const authorityInputIds = new Set(prompts.map(({ input }) => input.id))
  const visibleLocalSubmissions = localSubmissions.filter(
    (submission) =>
      !submission.dismissed &&
      !authorityInputIds.has(submission.id) &&
      (submission.placement === "queue" || submission.phase === "failed")
  )
  const activeCandidateRunId =
    activeRunId ??
    prompts.reduce<PendingPrompt | undefined>(
      (oldest, prompt) =>
        !oldest || prompt.run.createdAt < oldest.run.createdAt ? prompt : oldest,
      undefined
    )?.run.id
  const visiblePrompts = prompts.filter(
    ({ run, action }) =>
      action?.phase !== "acknowledged" &&
      (run.id !== activeCandidateRunId || action?.phase === "failed")
  )
  // 仅合并展示数据；队列次序、提交和去重仍由现有 store 负责。
  const rows = [
    ...visibleLocalSubmissions.map((submission) => ({
      id: `input:${submission.id}`,
      content: submission.content,
      error: submission.phase === "failed" ? submission.error : undefined,
      attention: submission.phase === "failed" || submission.phase === "submitting",
      indicator:
        submission.phase === "failed" ? (
          <AlertCircle />
        ) : submission.phase === "submitting" ? (
          <Spinner />
        ) : (
          <Clock3 />
        ),
      actions: (
        <>
          <span className="text-xs text-muted-foreground">
            {submission.phase === "submitting"
              ? "正在发送"
              : submission.phase === "accepted"
                ? "等待处理"
                : "发送失败"}
          </span>
          {submission.phase === "failed" ? (
            <>
              {onRetryLocal ? (
                <Button
                  type="button"
                  variant="ghost"
                  shape="pill"
                  size="sm"
                  onClick={() => onRetryLocal(submission.id)}
                >
                  核对并重试
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                shape="circle"
                size="icon-sm"
                aria-label="关闭发送错误"
                title="关闭"
                onClick={() => onDismissLocal(submission.id)}
              >
                <X />
              </Button>
            </>
          ) : null}
        </>
      ),
    })),
    ...visiblePrompts.map(({ input, run, action }) => {
      const promoting = action?.kind === "promote" && action.phase === "pending"
      const cancelling = action?.kind === "cancel" && action.phase === "pending"
      const busy = action?.phase === "pending"
      return {
        id: `run:${run.id}`,
        content: input.content,
        error: action?.phase === "failed" ? action.error : undefined,
        attention: action?.phase === "failed" || busy,
        indicator: action?.phase === "failed" ? <AlertCircle /> : <Clock3 />,
        actions: (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    shape="circle"
                    size="icon-sm"
                    disabled={!activeRunId || busy}
                    aria-label="补充到当前任务"
                    aria-busy={promoting || undefined}
                    onClick={() => onPromote(input.id, run.id)}
                  >
                    {promoting ? <Spinner /> : <CornerDownRight />}
                  </Button>
                }
              />
              <TooltipContent>补充到当前任务，成功后不再单独排队。</TooltipContent>
            </Tooltip>
            <Button
              type="button"
              variant="ghost"
              shape="circle"
              size="icon-sm"
              disabled={busy}
              aria-busy={cancelling || undefined}
              aria-label="删除待处理消息"
              title={cancelling ? "正在删除" : "删除待处理消息"}
              onClick={() => onCancel(input.id, run.id)}
            >
              {cancelling ? <Spinner /> : <X />}
            </Button>
          </>
        ),
      }
    }),
  ]
  if (rows.length === 0) return null
  const hiddenCount = rows.filter((row, index) => index >= 3 && !row.attention).length
  const shown = expanded ? rows : rows.filter((row, index) => index < 3 || row.attention)
  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label="待处理消息队列">
      {rows.length > 1 ? (
        <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
          待处理消息 · {rows.length}
        </p>
      ) : null}
      <ItemGroup id={listId} className="gap-0.5 has-data-[size=xs]:gap-0.5" aria-label="待处理消息">
        {shown.map((row) => (
          <Item
            key={row.id}
            role="listitem"
            variant="default"
            size="xs"
            className="min-h-8 px-1 py-0"
          >
            <ItemMedia variant="icon" aria-hidden>
              {row.indicator}
            </ItemMedia>
            <ItemContent className="min-w-0">
              <QueueMessageContent content={row.content} />
              {row.error ? (
                <p role="alert" className="text-xs leading-snug text-destructive">
                  {row.error}
                </p>
              ) : null}
            </ItemContent>
            <ItemActions>{row.actions}</ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {hiddenCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          shape="pill"
          size="sm"
          className="self-start"
          aria-controls={listId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown data-icon="inline-start" className={expanded ? "rotate-180" : undefined} />
          {expanded ? "收起更多消息" : `展开其余 ${hiddenCount} 条`}
        </Button>
      ) : null}
    </section>
  )
}

function QueueMessageContent({ content }: { content: string }) {
  return (
    <Collapsible className="flex min-w-0 flex-col">
      <CollapsibleTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            shape="pill"
            className="h-7 min-w-0 justify-start px-1 py-0"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left font-normal">
          {content || "（无正文）"}
        </span>
        <ChevronDown data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-48 overflow-y-auto px-1 py-2 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap select-text">
        {content || "（无正文）"}
      </CollapsibleContent>
    </Collapsible>
  )
}
