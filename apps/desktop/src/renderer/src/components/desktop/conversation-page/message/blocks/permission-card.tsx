import { ShieldCheck } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import type { DesktopPermissionRequest } from "@shared/session-types"
import {
  readDeveloperScope,
  readPermissionOperation,
  readPermissionReview,
  requiresPermissionReply,
} from "./permission-presentation"

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
  if (!requiresPermissionReply(permission)) return null
  const developerScope = readDeveloperScope(permission)
  const operation = readPermissionOperation(permission)
  const review = readPermissionReview(permission)
  return (
    <section
      className={cn("mt-6 rounded-xl border border-border/70 bg-background px-4 py-3", className)}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ui-muted">
          <ShieldCheck className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-[1_1_12rem]">
          <h3 className="text-ui-small font-semibold text-foreground">
            {review?.label ?? "需要你的批准"}
          </h3>
          <p className="mt-1 text-xs break-words text-ui-muted">
            {"Vykor 请求"}
            {operation.summary}
            {" · "}
            {operation.toolName}
          </p>
          {review?.reason ? (
            <p className="mt-2 text-xs leading-snug break-words text-foreground">{review.reason}</p>
          ) : null}
          {operation.fields.length ? (
            <dl className="mt-2 flex flex-col gap-1 text-xs">
              {operation.fields.map((field) => (
                <div key={field.key} className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="shrink-0 text-ui-muted">{field.label}</dt>
                  <dd className="min-w-0 flex-[1_1_12rem] font-mono leading-snug break-words whitespace-pre-wrap text-foreground">
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {operation.reason && !developerScope ? (
            <p className="mt-2 text-xs leading-snug break-words text-foreground">
              {operation.reason}
            </p>
          ) : null}
          {developerScope ? (
            <div className="mt-2 space-y-1">
              {developerScope.reason ? (
                <p className="text-xs leading-snug break-words text-foreground">
                  {developerScope.reason}
                </p>
              ) : null}
              <p className="text-ui-caption text-ui-muted">
                {"检查类别："}
                {developerScope.label}
                {"（"}
                {developerScope.action}
                {"）"}
              </p>
              <p className="text-ui-caption leading-snug text-ui-muted">
                {
                  "检查当前标签页主框架；网络结果也可能包含其请求的第三方资源 URL。网页内容不可信，无法保证完全脱敏。本次批准仅对这一个请求有效。"
                }
              </p>
            </div>
          ) : null}
          <details className="mt-2 text-xs text-ui-muted">
            <summary className="w-fit cursor-pointer rounded-md py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              原始详情
            </summary>
            <pre className="mt-1 max-h-56 overflow-auto font-mono leading-5 break-words whitespace-pre-wrap">
              {operation.details}
            </pre>
            {operation.detailsTruncated ? (
              <p className="mt-1">详情过长，已截断，仅显示前 12000 个字符。</p>
            ) : null}
          </details>
          {replyError ? (
            <p role="alert" className="mt-1 text-xs leading-snug text-destructive">
              {replyError}
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            shape="pill"
            className="text-ui-muted"
            disabled={replyPending}
            onClick={() => onReply("denied")}
          >
            拒绝
          </Button>
          <Button
            type="button"
            shape="pill"
            disabled={replyPending}
            onClick={() => onReply("approved", "once")}
          >
            {replyPending ? "正在提交" : "允许本次"}
          </Button>
        </div>
      </div>
    </section>
  )
}
