import { ChevronLeft, ChevronRight } from "lucide-react"
import { Activity, useState } from "react"
import {
  ComputerAppPermissionCard,
  useComputerAppPermissionId,
} from "@renderer/components/desktop/tools/computer/computer-interaction"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import type { PermissionReplyState } from "@renderer/stores/desktop-session/selectors"
import type { DesktopPermissionRequest } from "@shared/session-types"
import { AskUserCard } from "./ask-user-card"
import { isAskUserPermission } from "./ask-user-payload"
import { PermissionCard } from "./permission-card"

interface PermissionStackProps {
  sessionId: string
  permissions: DesktopPermissionRequest[]
  replies: Record<string, PermissionReplyState>
  onReply: (
    id: string,
    status: "approved" | "denied",
    decision?: "once" | "session",
    answer?: string
  ) => void
  className?: string
}

export function PermissionStack({
  sessionId,
  permissions,
  replies,
  onReply,
  className,
}: PermissionStackProps) {
  const computerId = useComputerAppPermissionId(sessionId)
  const computerKey = computerId ? `computer:${computerId}` : undefined
  const keys = permissions.map((permission) => `permission:${permission.id}`)
  if (computerKey) keys.push(computerKey)

  const [order, setOrder] = useState(keys)
  const [selected, setSelected] = useState<string | undefined>(keys[0])
  if (keys.length !== order.length || keys.some((key, index) => key !== order[index])) {
    setOrder(keys)
    if (!selected || !keys.includes(selected)) {
      // A snapshot may settle several requests at once. Continue with the next surviving one.
      const next =
        selected && order.slice(order.indexOf(selected) + 1).find((key) => keys.includes(key))
      setSelected(next || keys[0])
    }
  }

  if (!keys.length) return null
  const index = selected ? keys.indexOf(selected) : 0
  const stacked = keys.length > 1
  return (
    <section aria-label="待处理的授权请求" className={cn("min-w-0", className)}>
      {stacked ? (
        <div className="mb-1 flex items-center justify-end gap-1 text-ui-muted">
          <Button
            type="button"
            shape="circle"
            size="icon-sm"
            variant="ghost"
            aria-label="上一个请求"
            title="上一个请求"
            disabled={index <= 0}
            onClick={() => setSelected(keys[index - 1])}
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
          </Button>
          <span role="status" aria-atomic="true" className="text-xs tabular-nums">
            <span className="sr-only">待处理请求 </span>
            {index + 1} / {keys.length}
          </span>
          <Button
            type="button"
            shape="circle"
            size="icon-sm"
            variant="ghost"
            aria-label="下一个请求"
            title="下一个请求"
            disabled={index >= keys.length - 1}
            onClick={() => setSelected(keys[index + 1])}
          >
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div className={cn("relative isolate", stacked && (keys.length > 2 ? "pb-3" : "pb-1.5"))}>
        {keys.length > 2 ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-5 top-4 bottom-0 -z-10 rounded-xl border border-border/70 bg-muted"
          />
        ) : null}
        {stacked ? (
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-2.5 top-2 -z-10 rounded-xl border border-border/80 bg-background",
              keys.length > 2 ? "bottom-1.5" : "bottom-0"
            )}
          />
        ) : null}
        {permissions.map((permission, position) => {
          const visible = keys[position] === selected
          const reply = replies[permission.id]
          if (isAskUserPermission(permission)) {
            // Activity keeps answers while hidden and remeasures the form when it is revealed.
            return (
              <Activity key={permission.id} mode={visible ? "visible" : "hidden"}>
                <div hidden={!visible} inert={!visible}>
                  <AskUserCard
                    key={reply?.error ?? "active"}
                    permission={permission}
                    replyPending={reply?.pending}
                    replyError={reply?.error}
                    onReply={(answer) => onReply(permission.id, "approved", "once", answer)}
                  />
                </div>
              </Activity>
            )
          }
          return visible ? (
            <PermissionCard
              key={permission.id}
              permission={permission}
              replyPending={reply?.pending}
              replyError={reply?.error}
              onReply={(status, decision) => onReply(permission.id, status, decision)}
            />
          ) : null
        })}
        {computerKey && selected === computerKey ? (
          <ComputerAppPermissionCard key={computerKey} sessionId={sessionId} />
        ) : null}
      </div>
    </section>
  )
}
