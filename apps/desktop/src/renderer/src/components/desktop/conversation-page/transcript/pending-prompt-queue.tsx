import { useState } from "react"
import { CornerDownRight, GripVertical, Paperclip, Trash2 } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@renderer/components/ui/item"
import { Spinner } from "@renderer/components/ui/spinner"
import { classifyFollowUps, FOLLOW_UP_TARGET_UNAVAILABLE, queuedPromptActionKey } from "@renderer/stores/desktop-session/pending-prompt-state"
import type {
  PendingPromptSubmission,
  QueuedPromptAction,
} from "@renderer/stores/desktop-session/types"
import type { DesktopSessionInput, DesktopSessionRun, DesktopSessionView } from "@shared/session-types"
import { readBrowserAnnotationContext } from "@renderer/components/desktop/tools/browser/browser-annotation-context"

interface PendingPrompt {
  input: DesktopSessionInput
  run: DesktopSessionRun
  action?: Pick<QueuedPromptAction, "kind" | "phase" | "error">
}

type LocalPendingSubmission = Pick<
  PendingPromptSubmission,
  | "id"
  | "sessionId"
  | "content"
  | "phase"
  | "placement"
  | "error"
  | "dismissed"
  | "browserAnnotationContext"
  | "delivery"
> & { attachments?: PendingPromptSubmission["attachments"]; restorable?: boolean }

export function queuedPrompts(
  view: DesktopSessionView | null,
  actions: Record<string, QueuedPromptAction>
): PendingPrompt[] {
  if (!view) return []
  return view.runs
    .filter(run => run.status === "pending" && run.inputId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .flatMap(run => {
      const input = view.inputs.find(candidate => candidate.id === run.inputId)
      return input ? [{ input, run, action: actions[queuedPromptActionKey(run.sessionId, run.id)] }] : []
    })
}

export function followUpFeedback(
  view: DesktopSessionView | null,
  local: LocalPendingSubmission[]
): LocalPendingSubmission[] {
  if (!view) return local
  const feedback = new Map(local.map(submission => [submission.id, {
    ...submission, restorable: submission.error === FOLLOW_UP_TARGET_UNAVAILABLE,
  }]))
  const statuses = classifyFollowUps(view)
  for (const input of view.inputs) {
    const status = statuses.get(input.id)
    if (!status) continue
    if (status === "applied") {
      feedback.delete(input.id)
      continue
    }
    const waiting = status === "waiting"
    if (waiting && feedback.get(input.id)?.placement === "transcript") continue
    feedback.set(input.id, {
      id: input.id,
      sessionId: input.sessionId,
      content: input.content,
      delivery: "steer",
      placement: "queue",
      phase: waiting ? "accepted" : "failed",
      restorable: !waiting,
      ...(waiting ? {} : { error: "这条补充未进入当前回复。" }),
    })
  }
  return [...feedback.values()]
}

export function PendingPromptQueue({
  prompts,
  activeRunId,
  localSubmissions = [],
  onPromote,
  onCancel,
  onDismissLocal = () => {},
  onRetryLocal,
  onRestoreLocal,
}: {
  prompts: PendingPrompt[]
  activeRunId?: string
  localSubmissions?: LocalPendingSubmission[]
  onPromote: (inputId: string, queuedRunId: string) => void
  onCancel: (inputId: string, queuedRunId: string) => void
  onDismissLocal?: (inputId: string) => void
  onRetryLocal?: (inputId: string) => void
  onRestoreLocal?: (inputId: string) => Promise<boolean>
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const authorityInputIds = new Set(prompts.map(({ input }) => input.id))
  const visibleLocalSubmissions = localSubmissions.filter(
    (submission) =>
      !submission.dismissed &&
      !dismissed.has(submission.id) &&
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
      (action?.phase !== "acknowledged" || (run.metadata.promotion as { kind?: string } | undefined)?.kind === "steering") &&
      (run.id !== activeCandidateRunId || action?.phase === "failed")
  )
  if (visiblePrompts.length === 0 && visibleLocalSubmissions.length === 0) return null

  return (
    <ItemGroup
      className="max-h-48 gap-1 overflow-y-auto p-1 has-data-[size=xs]:gap-1"
      aria-label="待处理消息"
    >
      {visibleLocalSubmissions.map((visibleLocalSubmission) => (
        <Item
          key={visibleLocalSubmission.id}
          variant="default"
          size="xs"
          className="min-h-10 flex-nowrap items-start gap-2 rounded-lg px-2 py-1"
        >
          <ItemMedia className="h-7 w-4" aria-hidden>
            {visibleLocalSubmission.phase === "failed" ? (
              <span className="text-xs font-semibold text-destructive">!</span>
            ) : (
              <Spinner className="size-3.5" />
            )}
          </ItemMedia>
          <ItemContent className="min-w-0 gap-1 pt-1 group-data-[size=xs]/item:gap-1">
            <PendingPromptTitle
              content={visibleLocalSubmission.content}
              browserAnnotationContext={visibleLocalSubmission.browserAnnotationContext}
              attachments={visibleLocalSubmission.attachments}
            />
            {visibleLocalSubmission.phase === "failed" && visibleLocalSubmission.error ? (
              <p role="alert" className="text-xs leading-snug wrap-anywhere text-destructive">
                {visibleLocalSubmission.error}
              </p>
            ) : null}
          </ItemContent>
          <ItemActions className="min-h-7 shrink-0 gap-1">
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {visibleLocalSubmission.phase === "submitting"
                ? "正在发送"
                : visibleLocalSubmission.phase === "accepted"
                  ? visibleLocalSubmission.delivery === "steer" ? "等候进入当前回复" : "等待处理"
                  : "发送失败"}
            </span>
            {visibleLocalSubmission.phase === "failed" ? (
              <>
                {visibleLocalSubmission.restorable && onRestoreLocal ? (
                  <Button type="button" variant="ghost" shape="pill" size="sm" onClick={() => {
                    void onRestoreLocal(visibleLocalSubmission.id).then(restored => {
                      if (restored) setDismissed(current => new Set([...current, visibleLocalSubmission.id]))
                    }).catch(() => undefined)
                  }}>
                    恢复到草稿
                  </Button>
                ) : null}
                {onRetryLocal && !visibleLocalSubmission.restorable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    shape="pill"
                    size="sm"
                    onClick={() => onRetryLocal(visibleLocalSubmission.id)}
                  >
                    核对并重试
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  shape="circle"
                  size="icon-sm"
                  className="[&_svg]:size-3.5"
                  aria-label="关闭发送错误"
                  title="关闭"
                  onClick={() => {
                    setDismissed(current => new Set([...current, visibleLocalSubmission.id]))
                    onDismissLocal(visibleLocalSubmission.id)
                  }}
                >
                  <Trash2 />
                </Button>
              </>
            ) : null}
          </ItemActions>
        </Item>
      ))}
      {visiblePrompts.map(({ input, run, action }) => {
        const promoting = action?.kind === "promote" && action.phase === "pending"
        const cancelling = action?.kind === "cancel" && action.phase === "pending"
        const promotion = run.metadata.promotion as { kind?: string; accepted?: boolean } | undefined
        const waitingToApply = promotion?.kind === "steering" && promotion.accepted
        const busy = action?.phase === "pending" || promotion?.kind === "steering"
        return (
          <Item
            key={run.id}
            variant="default"
            size="xs"
            className="min-h-10 flex-nowrap items-start gap-2 rounded-lg px-2 py-1"
          >
            <ItemMedia className="h-7 w-4" aria-hidden>
              <GripVertical className="size-3.5 text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0 gap-1 pt-1 group-data-[size=xs]/item:gap-1">
              <PendingPromptTitle content={input.content} attachments={input.attachments} />
              {action?.phase === "failed" && action.error ? (
                <p role="alert" className="text-xs leading-snug wrap-anywhere text-destructive">
                  {action.error}
                </p>
              ) : null}
            </ItemContent>
            <ItemActions className="min-h-7 shrink-0 gap-1">
              {waitingToApply ? <span className="text-xs text-muted-foreground">等候进入当前回复</span> : null}
              <Button
                type="button"
                variant="ghost"
                shape="pill"
                size="sm"
                disabled={!activeRunId || busy}
                onClick={() => onPromote(input.id, run.id)}
              >
                {promoting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <CornerDownRight data-icon="inline-start" />
                )}
                调整方向
              </Button>
              <Button
                type="button"
                variant="ghost"
                shape="circle"
                size="icon-sm"
                className="[&_svg]:size-3.5"
                disabled={cancelling || waitingToApply}
                aria-label="删除待处理消息"
                title="删除待处理消息"
                onClick={() => onCancel(input.id, run.id)}
              >
                {cancelling ? <Spinner /> : <Trash2 />}
              </Button>
            </ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}

function PendingPromptTitle({
  content,
  browserAnnotationContext,
  attachments = [],
}: {
  content: string
  browserAnnotationContext?: string | null
  attachments?: readonly { displayName?: string }[]
}): React.JSX.Element {
  const context = readBrowserAnnotationContext(content + (browserAnnotationContext ?? ""))
  const text = context?.text ?? content
  const annotationCount = context?.annotations.length ?? 0
  const attachmentOnly = !text.trim() && !annotationCount && attachments.length > 0
  const firstName = attachments[0]?.displayName?.trim()
  let summary = !text.trim() && annotationCount ? `${annotationCount} 条批注` : text
  if (attachmentOnly) {
    summary = firstName
      ? firstName + (attachments.length > 1 ? ` 等 ${attachments.length} 个附件` : "")
      : `${attachments.length} 个附件`
  }
  return (
    <ItemTitle
      className="block w-full truncate font-normal"
      title={
        attachmentOnly
          ? attachments
              .map((attachment) => attachment.displayName?.trim() || "未命名附件")
              .join("\n")
          : undefined
      }
    >
      {attachmentOnly ? (
        <Paperclip
          aria-hidden
          strokeWidth={1.75}
          className="mr-1 inline-block size-3.5 align-text-bottom text-muted-foreground"
        />
      ) : null}
      {summary}
    </ItemTitle>
  )
}
