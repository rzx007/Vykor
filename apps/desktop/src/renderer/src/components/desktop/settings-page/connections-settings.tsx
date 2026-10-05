import { useCallback, useEffect, useState } from "react"
import type { ChannelDenialNotice } from "@vykor/client"
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  ChevronDown,
  Clock3,
  Info,
  MoreHorizontal,
  QrCode,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react"
import { StatefulButton } from "@renderer/components/motion/button/stateful"
import { Alert, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { Separator } from "@renderer/components/ui/separator"
import { Spinner } from "@renderer/components/ui/spinner"
import { Switch } from "@renderer/components/ui/switch"
import { cn } from "@renderer/lib/utils"
import type {
  DesktopConnectionsSnapshot,
  DesktopFeishuAllowInput,
  DesktopFeishuPatchInput,
} from "@shared/channel-types"
import { ConnectionChannelRow, FeishuConnectionIcon } from "./connection-channel-row"
import { FeishuConnectionDetails } from "./feishu-connection-details"
import { FeishuConnectionDialog } from "./feishu-connection-dialog"
import { errorMessage } from "./settings-error-message"

const POLL_INTERVAL_MS = 3000
const MAX_POLL_INTERVAL_MS = 30_000

export function ConnectionsSettings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopConnectionsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denials, setDenials] = useState<ChannelDenialNotice[]>([])
  const [connectOpen, setConnectOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.desktop.connections
      .snapshot()
      .then((value) => {
        if (!cancelled) setSnapshot(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let delay = POLL_INTERVAL_MS
    const poll = async (): Promise<void> => {
      try {
        const delta = await window.desktop.connections.runtimeStatus()
        if (cancelled) return
        setSnapshot((current) => (current ? { ...current, runtime: delta.runtime } : current))
        if (delta.newDenials.length > 0)
          setDenials((current) => [...delta.newDenials, ...current].slice(0, 20))
        delay = POLL_INTERVAL_MS
      } catch {
        delay = Math.min(delay * 2, MAX_POLL_INTERVAL_MS)
      } finally {
        if (!cancelled) timer = setTimeout(poll, delay)
      }
    }
    timer = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const connected = useCallback((value: DesktopConnectionsSnapshot): void => {
    setSnapshot(value)
    setDetailsOpen(true)
    setError(null)
  }, [])
  const refresh = async (): Promise<void> => {
    setSnapshot(await window.desktop.connections.snapshot())
  }
  const run = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    setBusy(label)
    setError(null)
    try {
      await action()
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusy(null)
    }
  }
  const patch = (input: DesktopFeishuPatchInput): void => {
    void run("patch", async () => setSnapshot(await window.desktop.connections.patch(input)))
  }
  const addAllow = async (input: DesktopFeishuAllowInput): Promise<boolean> =>
    run("allow", async () => {
      const feishu = await window.desktop.connections.allowAdd(input)
      setSnapshot((current) => (current ? { ...current, feishu } : current))
    })
  const removeAllow = (name: string): void => {
    void run("allow", async () => {
      const feishu = await window.desktop.connections.allowRemove(name)
      setSnapshot((current) => (current ? { ...current, feishu } : current))
    })
  }
  const allowDenied = (denial: ChannelDenialNotice): void => {
    void addAllow({ id: denial.sender }).then((ok) => {
      if (ok)
        setDenials((items) =>
          items.filter((item) => !(item.connector === denial.connector && item.seq === denial.seq))
        )
    })
  }
  const retryRuntime = (): void => {
    void run("runtime", async () => {
      await window.desktop.connections.startRuntime()
      await refresh()
    })
  }
  const removeChannel = (): void => {
    void run("remove", async () => {
      setSnapshot(await window.desktop.connections.remove())
      setRemoveOpen(false)
      setDetailsOpen(false)
      setDenials([])
    })
  }

  if (loading)
    return (
      <div className="flex min-h-32 items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner />
        正在读取渠道状态…
      </div>
    )

  const feishu = snapshot?.feishu
  const connector = snapshot?.runtime.connectors.find((item) => item.connector === "feishu")
  const configured = feishu?.configured ?? false
  const enabled = feishu?.enabled ?? false
  const label = statusLabel(configured, enabled, connector?.state)
  const channelDenials = denials.filter((item) => item.connector === "feishu")
  const runtimeError = configured && enabled && connector?.state === "error"

  return (
    <div className="flex flex-col gap-5" aria-busy={busy !== null}>
      {error && !removeOpen ? (
        <Alert variant="destructive">
          <Info />
          <AlertTitle>{error}</AlertTitle>
          {!snapshot ? (
            <AlertDescription>
              <Button variant="ghost" size="sm" onClick={() => void run("refresh", refresh)}>
                重新读取
              </Button>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      <section aria-labelledby="connection-channels-heading" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 py-1">
          <h2 id="connection-channels-heading" className="text-sm font-semibold">
            聊天渠道
          </h2>
          <span className="text-xs text-muted-foreground">
            {configured ? "已添加 1 个" : "选择一个渠道开始"}
          </span>
        </div>
        <ConnectionChannelRow
          id="feishu"
          name={feishu?.domain === "lark" ? "Lark（国际版）" : "飞书"}
          icon={<FeishuConnectionIcon />}
          description={
            configured
              ? (feishu?.botName ?? "飞书机器人") +
                " · " +
                (feishu?.domain === "lark" ? "国际版" : "中国大陆")
              : "扫码创建机器人，在私聊和群聊中使用 Vykor。"
          }
          status={
            configured ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-xs text-muted-foreground",
                  runtimeError && "text-destructive"
                )}
                role="status"
              >
                {runtimeError ? (
                  <CircleX className="size-3" />
                ) : enabled && connector?.state === "running" ? (
                  <CircleCheck className="size-3" />
                ) : (
                  <Clock3 className="size-3" />
                )}
                {label}
              </span>
            ) : null
          }
          actions={
            configured ? (
              <>
                <Switch
                  aria-label="启用飞书渠道"
                  title={enabled ? "停用飞书渠道" : "启用飞书渠道"}
                  checked={enabled}
                  disabled={busy !== null}
                  onCheckedChange={(value) => patch({ enabled: value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  shape="pill"
                  aria-expanded={detailsOpen}
                  aria-controls="feishu-connection-details"
                  onClick={() => setDetailsOpen((value) => !value)}
                >
                  {detailsOpen ? "收起" : "管理"}
                  <ChevronDown
                    data-icon="inline-end"
                    aria-hidden="true"
                    className={cn("transition-transform", detailsOpen && "rotate-180")}
                  />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        shape="circle"
                        size="icon-sm"
                        aria-label="飞书更多操作"
                        disabled={busy !== null}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem disabled={busy !== null} onClick={retryRuntime}>
                        <RefreshCw />
                        重试连接
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy !== null || connector?.state !== "running"}
                        onClick={() =>
                          void run("runtime", async () => {
                            await window.desktop.connections.stopRuntime()
                            await refresh()
                          })
                        }
                      >
                        <Clock3 />
                        临时停止
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={busy !== null}
                        onClick={() => {
                          setError(null)
                          setRemoveOpen(true)
                        }}
                      >
                        <X />
                        移除连接
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <Button
                size="sm"
                shape="pill"
                aria-label="连接飞书"
                disabled={!snapshot || busy !== null}
                onClick={() => setConnectOpen(true)}
              >
                <QrCode data-icon="inline-start" />
                连接
              </Button>
            )
          }
        >
          <Separator />
          {runtimeError ? (
            <Alert variant="destructive" className="mt-4">
              <CircleX />
              <AlertTitle>暂时无法连接飞书</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 break-words">
                  {connector?.lastError ?? "检查网络后重试，已有配置会保留。"}
                </p>
                <StatefulButton
                  size="sm"
                  variant="outline"
                  pressScale={1}
                  state={busy === "runtime" ? "loading" : "idle"}
                  disabled={busy !== null}
                  loadingText="正在连接"
                  onClick={retryRuntime}
                >
                  重试连接
                </StatefulButton>
              </AlertDescription>
            </Alert>
          ) : null}
          {configured && detailsOpen && feishu ? (
            <div id="feishu-connection-details" className="pt-1 pb-1 sm:pl-14">
              <FeishuConnectionDetails
                feishu={feishu}
                busy={busy !== null}
                onAllowAdd={addAllow}
                onAllowRemove={removeAllow}
                onPatch={patch}
              />
            </div>
          ) : null}
        </ConnectionChannelRow>
        {!configured ? (
          <p className="flex items-start gap-2 py-3 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            连接后可管理谁能使用机器人，以及消息展示方式。
          </p>
        ) : null}
      </section>
      {configured && channelDenials.length > 0 ? (
        <section aria-labelledby="connection-denials-heading">
          <h3 id="connection-denials-heading" className="mb-3 text-sm font-semibold">
            未放行的消息
          </h3>
          <ul className="flex flex-col gap-3">
            {channelDenials.map((denial) => (
              <li
                key={denial.connector + ":" + denial.seq}
                className="flex flex-wrap items-center gap-3"
              >
                <div className="min-w-0 flex-1 text-xs">
                  <p className="break-all">{denial.sender}</p>
                  <p className="mt-1 break-all text-muted-foreground">
                    会话 {denial.chatId} · 不在允许列表中
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  shape="pill"
                  disabled={busy !== null}
                  onClick={() => allowDenied(denial)}
                >
                  加入白名单
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <CircleHelp className="size-3.5" />
        连接问题？
        <Button
          variant="link"
          size="sm"
          onClick={() =>
            void run("help", async () => {
              await window.desktop.window.openExternal(
                "https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs"
              )
            })
          }
        >
          查看飞书接入说明
        </Button>
      </p>
      <FeishuConnectionDialog
        open={connectOpen}
        snapshot={snapshot}
        onOpenChange={setConnectOpen}
        onConnected={connected}
      />
      <Dialog
        open={removeOpen}
        onOpenChange={(value) => {
          if (busy !== "remove") setRemoveOpen(value)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除飞书连接？</DialogTitle>
            <DialogDescription>
              删除本机保存的凭据和访问权限，并停止接收消息。飞书侧的应用仍会保留。
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <Info />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              shape="pill"
              disabled={busy !== null}
              onClick={() => setRemoveOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              shape="pill"
              disabled={busy !== null}
              onClick={removeChannel}
            >
              {busy === "remove" ? "移除中…" : "移除连接"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function statusLabel(configured: boolean, enabled: boolean, state: string | undefined): string {
  if (!configured) return "未连接"
  if (!enabled) return "已停用"
  switch (state) {
    case "running":
      return "已连接"
    case "starting":
      return "连接中"
    case "stopping":
      return "停止中"
    case "error":
      return "连接异常"
    default:
      return "已停止"
  }
}
