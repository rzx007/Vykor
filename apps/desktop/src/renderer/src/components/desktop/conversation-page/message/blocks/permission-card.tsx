import type { LucideIcon } from "lucide-react"
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button } from "@renderer/components/ui/button"
import { Checkbox } from "@renderer/components/ui/checkbox"
import { cn } from "@renderer/lib/utils"
import type { DesktopPermissionRequest } from "@shared/session-types"
import {
  readDeveloperScope,
  readPermissionOperation,
  readPermissionReview,
  requiresPermissionReply,
} from "./permission-presentation"

function RequestPreview({ json }: { json: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const valueId = useId()
  const preview = json.slice(0, 360).split("\n", 6).join("\n")
  const abbreviated = preview.length < json.length

  // Even a short JSON string can wrap past six lines in a narrow side chat.
  useLayoutEffect(() => {
    const pre = preRef.current
    if (!pre || abbreviated || expanded) return
    const measure = () => setOverflows(pre.scrollHeight > pre.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(pre)
    return () => observer.disconnect()
  }, [abbreviated, expanded, json])

  return (
    <section
      aria-label="请求内容"
      className="flex max-h-[min(14rem,30dvh)] min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/50 px-3 py-2"
    >
      <pre
        ref={preRef}
        id={valueId}
        tabIndex={expanded ? 0 : undefined}
        className={cn(
          "m-0 min-h-0 scrollbar-thin overscroll-contain font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
          expanded ? "overflow-y-auto" : "max-h-[6lh] overflow-hidden"
        )}
      >
        {expanded || !abbreviated ? json : `${preview}…`}
      </pre>
      {(abbreviated || overflows) && (
        <Button
          type="button"
          variant="ghost"
          shape="pill"
          size="sm"
          className="mt-1 shrink-0 self-start font-sans text-xs text-ui-muted"
          aria-controls={valueId}
          aria-expanded={expanded}
          onClick={() => {
            if (preRef.current) preRef.current.scrollTop = 0
            setExpanded(!expanded)
          }}
        >
          {expanded ? "收起" : "展开全部"}
        </Button>
      )}
    </section>
  )
}

export function PermissionCard({
  permission,
  onReply,
  replyPending = false,
  replyError = null,
}: {
  permission: DesktopPermissionRequest
  onReply: (status: "approved" | "denied", decision?: "once" | "session") => void
  replyPending?: boolean
  replyError?: string | null
}): React.JSX.Element | null {
  const operation = useMemo(
    () => (requiresPermissionReply(permission) ? readPermissionOperation(permission) : null),
    [permission]
  )
  if (!operation) return null
  const developerScope = readDeveloperScope(permission)
  const review = readPermissionReview(permission)
  return (
    <ApprovalRequestCard
      key={permission.id}
      title={permission.payload.computerApproval === true ? "批准这次电脑操作" : operation.summary}
      icon={operation.icon}
      toolName={operation.toolName}
      onApprove={() => onReply("approved", "once")}
      onDeny={() => onReply("denied")}
      replyPending={replyPending}
      replyError={replyError}
    >
      <RequestPreview json={operation.details} />
      {review && (
        <p className="[overflow-wrap:anywhere]">
          {review.label}
          {review.reason ? ` · ${review.reason}` : ""}
        </p>
      )}
      {developerScope && (
        <p className="text-ui-muted">
          检查类别：{developerScope.label}（{developerScope.action}）。检查当前标签页主框架；
          网络结果也可能包含其请求的第三方资源 URL。网页内容不可信，无法保证完全脱敏。本次批准仅对这一个请求有效。
        </p>
      )}
    </ApprovalRequestCard>
  )
}

export function ApprovalRequestCard({
  title,
  icon: Icon,
  toolName,
  children,
  approveLabel = "允许本次",
  onApprove,
  onDeny,
  remember,
  replyPending,
  replyError,
}: {
  title: string
  icon: LucideIcon
  toolName?: string
  children?: ReactNode
  approveLabel?: string
  onApprove: () => void
  onDeny: () => void
  remember?: { label: string; onApprove: () => void }
  replyPending?: boolean
  replyError?: string | null
}): React.JSX.Element {
  const [rememberChecked, setRememberChecked] = useState(false)
  const rememberId = useId()
  const rememberGrant = rememberChecked && remember
  return (
    <section className="text-ui-small flex max-h-[max(12rem,35dvh)] min-w-0 flex-col gap-2 overflow-y-auto rounded-xl border border-border/70 bg-background px-3.5 py-3 text-foreground">
      <div className="flex shrink-0 items-start gap-2">
        <Icon
          className="mt-0.5 size-4 shrink-0 text-ui-muted"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="font-semibold [overflow-wrap:anywhere]">{title}</h3>
          {toolName && (
            <code className="font-mono text-xs [overflow-wrap:anywhere] text-ui-muted">
              {toolName}
            </code>
          )}
        </div>
      </div>
      {children && (
        <div className="flex min-h-0 scrollbar-thin flex-col gap-2 overflow-y-auto overscroll-contain text-xs leading-relaxed">
          {children}
        </div>
      )}
      {replyError && (
        <p role="alert" className="shrink-0 text-xs [overflow-wrap:anywhere] text-destructive">
          {replyError}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {remember && (
          <label
            htmlFor={rememberId}
            className="flex min-w-0 cursor-pointer items-center gap-2 text-xs [overflow-wrap:anywhere] text-ui-muted"
          >
            <Checkbox
              id={rememberId}
              checked={rememberChecked}
              disabled={replyPending}
              onCheckedChange={setRememberChecked}
            />
            {remember.label}
          </label>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            shape="pill"
            className="text-ui-muted"
            disabled={replyPending}
            onClick={onDeny}
          >
            拒绝
          </Button>
          <Button
            type="button"
            shape="pill"
            disabled={replyPending}
            onClick={rememberGrant ? rememberGrant.onApprove : onApprove}
          >
            {replyPending ? "正在提交" : rememberGrant ? "始终允许" : approveLabel}
          </Button>
        </div>
      </div>
    </section>
  )
}
