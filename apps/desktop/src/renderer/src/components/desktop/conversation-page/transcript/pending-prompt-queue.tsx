import { CornerDownRight, GripVertical, Trash2 } from "lucide-react"

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
            <ItemTitle className="block w-full truncate font-normal">
              {visibleLocalSubmission.content}
            </ItemTitle>
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
                  ? "等待处理"
                  : "发送失败"}
            </span>
            {visibleLocalSubmission.phase === "failed" ? (
              <>
                {onRetryLocal ? (
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
                  onClick={() => onDismissLocal(visibleLocalSubmission.id)}
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
        const busy = action?.phase === "pending"
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
              <ItemTitle className="block w-full truncate font-normal">{input.content}</ItemTitle>
              {action?.phase === "failed" && action.error ? (
                <p role="alert" className="text-xs leading-snug wrap-anywhere text-destructive">
                  {action.error}
                </p>
              ) : null}
            </ItemContent>
            <ItemActions className="min-h-7 shrink-0 gap-1">
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
                disabled={busy}
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
