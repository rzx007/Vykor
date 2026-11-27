import { ChevronRight, type LucideIcon } from "lucide-react"
import { useId, useMemo, useState, type ReactNode } from "react"
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

function CommandPreview({ command }: { command: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const commandId = useId()
  const prefix = command.slice(0, 180)
  const lines = prefix.split(/\r\n|\r|\n/)
  const foldable = prefix.length < command.length || lines.length > 3
  const preview = foldable && !expanded
  return (
    <>
      <code
        id={commandId}
        className={cn(
          "block [overflow-wrap:anywhere] whitespace-pre-wrap",
          preview && "line-clamp-3"
        )}
      >
        {preview ? `${lines.slice(0, 3).join("\n")}…` : command}
      </code>
      {foldable && (
        <Button
          type="button"
          variant="ghost"
          shape="pill"
          size="sm"
          className="mt-1 font-sans text-xs text-ui-muted"
          aria-controls={commandId}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起命令" : "展开完整命令"}
        </Button>
      )}
    </>
  )
}

export function PermissionCard({
  permission,
  onReply,
  replyPending = false,
  replyError = null,
  className,
}: {
  permission: DesktopPermissionRequest
  onReply: (status: "approved" | "denied", decision?: "once" | "session") => void
  replyPending?: boolean
  replyError?: string | null
  className?: string
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
      className={className}
    >
      {operation.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2.5">
          {operation.fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className={field.key === "command" ? "sr-only" : "text-ui-muted"}>
                {field.label}
              </dt>
              <dd
                className={cn(
                  "min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap",
                  field.key === "command" && "col-span-2"
                )}
              >
                {field.key === "command" ? <CommandPreview command={field.value} /> : field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {operation.reason && (
        <p className="[overflow-wrap:anywhere] whitespace-pre-wrap text-ui-muted">
          {operation.reason}
        </p>
      )}
      {review && (
        <p className="[overflow-wrap:anywhere]">
          {review.label}
          {review.reason && review.reason !== operation.reason ? ` · ${review.reason}` : ""}
        </p>
      )}
      <details className="group/permission-details text-ui-muted">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm py-0.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 shrink-0 group-open/permission-details:rotate-90 motion-safe:transition-transform motion-safe:duration-150"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          查看详情
        </summary>
        <div className="mt-2 space-y-2">
          {developerScope && (
            <>
              <p>
                检查类别：{developerScope.label}（{developerScope.action}）
              </p>
              <p>
                检查当前标签页主框架；网络结果也可能包含其请求的第三方资源
                URL。网页内容不可信，无法保证完全脱敏。本次批准仅对这一个请求有效。
              </p>
            </>
          )}
          <p>原始请求</p>
          <pre className="font-mono [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
            {operation.details}
          </pre>
          {operation.detailsTruncated && <p>详情过长，已截断，仅显示前 12000 个字符。</p>}
        </div>
      </details>
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
  className,
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
  className?: string
}): React.JSX.Element {
  const [rememberChecked, setRememberChecked] = useState(false)
  const rememberId = useId()
  const rememberGrant = rememberChecked && remember
  return (
    <section
      className={cn(
        "text-ui-small flex max-h-[max(12rem,35dvh)] min-w-0 flex-col gap-2 overflow-y-auto rounded-xl border border-border/70 bg-background px-3.5 py-3 text-foreground",
        className
      )}
    >
      <div className="flex shrink-0 items-start gap-2">
        <Icon
          className="mt-0.5 size-4 shrink-0 text-primary"
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
        <div className="min-h-8 scrollbar-thin space-y-2 overflow-y-auto overscroll-contain pe-0.5 text-xs leading-relaxed">
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
