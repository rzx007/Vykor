import { useEffect, useRef, useState } from "react"
import type { ChannelDenialNotice } from "@openharness/client"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent } from "@renderer/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Input } from "@renderer/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Spinner } from "@renderer/components/ui/spinner"
import { Switch } from "@renderer/components/ui/switch"
import type {
  ChannelDomain,
  DesktopConnectionsSnapshot,
  DesktopFeishuRegistrationSnapshot,
} from "@shared/channel-types"
import { errorMessage } from "./settings-error-message"

const POLL_INTERVAL_MS = 3000
const MAX_POLL_INTERVAL_MS = 30_000

export function ConnectionsSettings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopConnectionsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denials, setDenials] = useState<ChannelDenialNotice[]>([])
  const [registration, setRegistration] =
    useState<DesktopFeishuRegistrationSnapshot | null>(null)
  const [method, setMethod] = useState<"scan" | "manual" | null>(null)
  const [manual, setManual] = useState<{
    appId: string
    appSecret: string
    domain: ChannelDomain
  }>({ appId: "", appSecret: "", domain: "feishu" })
  const [allowId, setAllowId] = useState("")
  const [allowName, setAllowName] = useState("")
  const [removeOpen, setRemoveOpen] = useState(false)
  const pollInFlight = useRef(false)

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
      if (pollInFlight.current) {
        timer = setTimeout(poll, delay)
        return
      }
      pollInFlight.current = true
      try {
        const delta = await window.desktop.connections.runtimeStatus()
        if (cancelled) return
        setSnapshot((current) => (current ? { ...current, runtime: delta.runtime } : current))
        if (delta.newDenials.length > 0) {
          setDenials((current) => [...delta.newDenials, ...current].slice(0, 20))
        }
        delay = POLL_INTERVAL_MS
      } catch {
        delay = Math.min(delay * 2, MAX_POLL_INTERVAL_MS)
      } finally {
        pollInFlight.current = false
        if (!cancelled) timer = setTimeout(poll, delay)
      }
    }
    timer = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!registration) return
    const active = ["starting", "qr_ready", "polling", "slow_down", "domain_switched"]
    if (!active.includes(registration.state)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const value = await window.desktop.connections.registrationStatus()
        if (!cancelled) setRegistration(value)
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause))
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000)
      }
    }
    timer = setTimeout(poll, 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [registration])

  const refresh = async (): Promise<void> => {
    const value = await window.desktop.connections.snapshot()
    setSnapshot(value)
  }

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const toggleEnabled = (enabled: boolean): void => {
    void run("enabled", async () => {
      const { feishu, runtime } = await window.desktop.connections.patch({ enabled })
      setSnapshot((current) => (current ? { feishu, runtime } : current))
    })
  }

  const startScan = (): void => {
    setMethod("scan")
    void run("registration", async () => {
      setRegistration(await window.desktop.connections.startRegistration({ domain: "feishu" }))
    })
  }

  const submitManual = (): void => {
    // 立即清掉明文密钥：无论成功失败都不在组件状态里保留。
    const input = { ...manual }
    setManual((current) => ({ ...current, appSecret: "" }))
    void run("manual", async () => {
      const { feishu, runtime } = await window.desktop.connections.connect(input)
      setSnapshot((current) => (current ? { feishu, runtime } : current))
      setMethod(null)
      setManual({ appId: "", appSecret: "", domain: "feishu" })
    })
  }

  const addAllow = (): void => {
    const id = allowId.trim()
    if (!id) return
    void run("allow", async () => {
      const feishu = await window.desktop.connections.allowAdd({
        id,
        ...(allowName.trim() ? { name: allowName.trim() } : {}),
      })
      setSnapshot((current) => (current ? { ...current, feishu } : current))
      setAllowId("")
      setAllowName("")
    })
  }

  const removeAllow = (key: string): void => {
    void run(`allow:${key}`, async () => {
      const feishu = await window.desktop.connections.allowRemove(key)
      setSnapshot((current) => (current ? { ...current, feishu } : current))
    })
  }

  const allowDenied = (denial: ChannelDenialNotice): void => {
    void run("allow", async () => {
      const feishu = await window.desktop.connections.allowAdd({ id: denial.sender })
      setSnapshot((current) => (current ? { ...current, feishu } : current))
      setDenials((current) => current.filter((item) => item.seq !== denial.seq))
    })
  }

  const removeChannel = (): void => {
    setRemoveOpen(false)
    void run("remove", async () => {
      const { feishu, runtime } = await window.desktop.connections.remove()
      setSnapshot((current) => (current ? { feishu, runtime } : current))
      setRegistration(null)
      setMethod(null)
    })
  }

  if (loading)
    return (
      <div
        className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <Spinner /> 正在读取渠道状态…
      </div>
    )

  const feishu = snapshot?.feishu
  const runtime = snapshot?.runtime
  const connector = runtime?.connectors.find((item) => item.connector === "feishu")

  return (
    <div className="flex flex-col gap-4" aria-busy={busy !== null}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-base font-semibold">飞书</h2>
            <Badge variant={badgeVariant(feishu?.configured ?? false, connector?.state)}>
              {statusLabel(feishu?.configured ?? false, feishu?.enabled ?? false, connector?.state)}
            </Badge>
            {feishu?.appId ? <Badge variant="outline">{feishu.appId}</Badge> : null}
            {feishu?.botName ? (
              <span className="text-xs text-muted-foreground">机器人：{feishu.botName}</span>
            ) : null}
          </div>
          {feishu?.replyAtBotNames?.length ? (
            <p className="text-xs text-muted-foreground">
              群聊 @ 机器人名：{feishu.replyAtBotNames.join("、")}
            </p>
          ) : null}
          {connector?.lastError ? (
            <p className="text-xs text-destructive">{connector.lastError}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                aria-label="启用飞书渠道"
                checked={feishu?.enabled ?? false}
                disabled={!feishu?.configured || busy !== null}
                onCheckedChange={toggleEnabled}
              />
              启用
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !feishu?.configured}
              onClick={() =>
                void run("runtime", async () => {
                  await window.desktop.connections.startRuntime()
                  await refresh()
                })
              }
            >
              重试连接
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || connector?.state !== "running"}
              onClick={() =>
                void run("runtime", async () => {
                  await window.desktop.connections.stopRuntime()
                  await refresh()
                })
              }
            >
              临时停止
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null || !feishu?.configured}
              onClick={() => setRemoveOpen(true)}
            >
              移除接入
            </Button>
          </div>

          {!feishu?.configured || method ? (
            <div className="flex flex-col gap-3 rounded-lg bg-muted/45 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy !== null} onClick={startScan}>
                  扫码接入
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setMethod(method === "manual" ? null : "manual")}
                >
                  手填接入
                </Button>
              </div>

              {registration ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    状态：{registration.state}
                    {registration.remainingSeconds !== undefined
                      ? `（剩余 ${registration.remainingSeconds}s）`
                      : ""}
                  </p>
                  {registration.qrDataUrl ? (
                    <img
                      src={registration.qrDataUrl}
                      alt="飞书接入二维码"
                      className="size-40 rounded-md bg-white p-2"
                    />
                  ) : registration.qrUrl ? (
                    <p className="text-xs text-destructive">二维码生成失败，请使用授权链接继续。</p>
                  ) : null}
                  {registration.qrUrl ? (
                    <a
                      href={registration.qrUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline"
                    >
                      在浏览器打开授权链接
                    </a>
                  ) : null}
                  {registration.warning ? (
                    <p className="text-xs text-destructive">{registration.warning}</p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run("registration", async () => {
                        setRegistration(await window.desktop.connections.cancelRegistration())
                      })
                    }
                  >
                    取消扫码
                  </Button>
                </div>
              ) : null}

              {method === "manual" ? (
                <div className="flex flex-col gap-2 sm:max-w-md">
                  <Input
                    aria-label="App ID"
                    placeholder="App ID"
                    value={manual.appId}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setManual((current) => ({ ...current, appId: event.target.value }))
                    }
                  />
                  <Input
                    aria-label="App Secret"
                    placeholder="App Secret"
                    type="password"
                    value={manual.appSecret}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setManual((current) => ({ ...current, appSecret: event.target.value }))
                    }
                  />
                  <Select
                    value={manual.domain}
                    onValueChange={(value) =>
                      setManual((current) => ({
                        ...current,
                        domain: value === "lark" ? "lark" : "feishu",
                      }))
                    }
                  >
                    <SelectTrigger aria-label="地区">
                      <SelectValue>{manual.domain === "lark" ? "国际 lark" : "国内 feishu"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="feishu">国内 feishu</SelectItem>
                        <SelectItem value="lark">国际 lark</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={busy !== null || !manual.appId || !manual.appSecret}
                    onClick={submitManual}
                  >
                    保存并连接
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {feishu?.configured ? (
        <Card>
          <CardContent className="flex flex-col gap-4 py-5">
            <h3 className="font-heading text-sm font-semibold">白名单</h3>
            <p className="text-xs text-muted-foreground">
              {feishu.allowFrom.length === 0
                ? "白名单为空：已配置但不放行任何人。"
                : "发送者或会话任一命中即放行。"}
            </p>
            <ul className="flex flex-col gap-2">
              {feishu.allowFrom.map((entry) => (
                <li key={entry.name} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {entry.name}（{entry.id}）
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => removeAllow(entry.name)}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="白名单 ID"
                placeholder="ou_… 或 oc_…"
                value={allowId}
                disabled={busy !== null}
                onChange={(event) => setAllowId(event.target.value)}
                className="sm:max-w-56"
              />
              <Input
                aria-label="白名单备注"
                placeholder="备注（可选）"
                value={allowName}
                disabled={busy !== null}
                onChange={(event) => setAllowName(event.target.value)}
                className="sm:max-w-40"
              />
              <Button size="sm" disabled={busy !== null || !allowId.trim()} onClick={addAllow}>
                添加
              </Button>
            </div>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label="发送进度"
                  checked={feishu.sendProgress ?? true}
                  disabled={busy !== null}
                  onCheckedChange={(value) =>
                    void run("patch", async () => {
                      const { feishu: next } = await window.desktop.connections.patch({
                        sendProgress: value,
                      })
                      setSnapshot((current) => (current ? { ...current, feishu: next } : current))
                    })
                  }
                />
                发送进度
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label="发送工具提示"
                  checked={feishu.sendToolHints ?? true}
                  disabled={busy !== null}
                  onCheckedChange={(value) =>
                    void run("patch", async () => {
                      const { feishu: next } = await window.desktop.connections.patch({
                        sendToolHints: value,
                      })
                      setSnapshot((current) => (current ? { ...current, feishu: next } : current))
                    })
                  }
                />
                发送工具提示
              </label>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {denials.length > 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <h3 className="font-heading text-sm font-semibold">被拒消息</h3>
            <ul className="flex flex-col gap-2">
              {denials.map((denial) => (
                <li key={`${denial.connector}:${denial.sender}:${denial.seq}`} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {denial.sender}（{denial.chatId}）不在白名单
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => allowDenied(denial)}
                  >
                    加入白名单
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除飞书接入</DialogTitle>
            <DialogDescription>
              会删除本机渠道配置并断开连接。之后可重新扫码或手填接入。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoveOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={removeChannel}>
              确认移除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function statusLabel(
  configured: boolean,
  enabled: boolean,
  state: string | undefined
): string {
  if (!configured) return "未配置"
  if (!enabled) return "已停用"
  switch (state) {
    case "running":
      return "在线"
    case "starting":
      return "连接中"
    case "stopping":
      return "停止中"
    case "error":
      return "失败"
    default:
      return "已停止"
  }
}

function badgeVariant(
  configured: boolean,
  state: string | undefined
): "default" | "secondary" | "destructive" | "outline" {
  if (!configured) return "outline"
  if (state === "running") return "default"
  if (state === "error") return "destructive"
  return "secondary"
}
