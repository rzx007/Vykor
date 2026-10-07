import { Link } from "@tanstack/react-router"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog"
import { Button } from "@renderer/components/ui/button"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  DesktopPermissionSettingsSnapshot,
  RevokeDesktopApprovalInput,
} from "@shared/permission-settings-types"
import { SettingsRow } from "./settings-group"

export function PermissionApprovalsDialog({
  snapshot,
  busy,
  open,
  onOpenChange,
  error,
  onRevoke,
}: {
  snapshot: DesktopPermissionSettingsSnapshot
  busy: boolean
  open: boolean
  onOpenChange(open: boolean): void
  error: string | null
  onRevoke(input: RevokeDesktopApprovalInput): void
}) {
  const approvalCount = snapshot.toolApprovals.length + snapshot.browserApprovals.length
  function sessionName(id: string) {
    return (
      useDesktopSessionStore.getState().sessions?.find((session) => session.id === id)?.title ||
      `对话 ${id.slice(0, 8)}`
    )
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!busy) onOpenChange(open)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>已保存授权</DialogTitle>
          <DialogDescription>工具授权按对话保存；站点授权仅本次运行有效。</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="max-h-80 divide-y divide-border overflow-y-auto">
          {!approvalCount ? (
            <p className="py-4 text-sm text-muted-foreground">暂无可撤销授权。</p>
          ) : null}
          {snapshot.toolApprovals.map((approval) => (
            <SettingsRow
              key={approval.id}
              title={approval.toolName}
              description={sessionName(approval.sessionId)}
              control={
                <Button
                  variant="ghost"
                  aria-label={`撤销 ${approval.toolName} 授权`}
                  disabled={busy}
                  onClick={() => onRevoke({ kind: "tool", id: approval.id })}
                >
                  撤销
                </Button>
              }
            />
          ))}
          {snapshot.browserApprovals.map((approval) => (
            <div
              key={`${approval.sessionId}:${approval.origin}`}
              className="flex items-center gap-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm break-all">{approval.origin}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {sessionName(approval.sessionId)}
                </p>
              </div>
              <Button
                variant="ghost"
                aria-label={`撤销 ${approval.origin} 授权`}
                disabled={busy}
                onClick={() => onRevoke({ kind: "browser", ...approval })}
              >
                撤销
              </Button>
            </div>
          ))}
        </div>
        <Link to="/plugins" className="text-xs underline underline-offset-4">
          管理插件权限
        </Link>
      </DialogContent>
    </Dialog>
  )
}
