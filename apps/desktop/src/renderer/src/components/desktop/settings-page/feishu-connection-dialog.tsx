import { useEffect, useId, useState } from "react"
import {
  CircleCheck,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  QrCode,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react"
import { BouncyAccordion } from "@renderer/components/motion/bouncy-accordion"
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Separator } from "@renderer/components/ui/separator"
import { Spinner } from "@renderer/components/ui/spinner"
import type {
  ChannelDomain,
  DesktopConnectionsSnapshot,
  DesktopFeishuRegistrationSnapshot,
} from "@shared/channel-types"
import { FeishuConnectionIcon } from "./connection-channel-row"
import { errorMessage } from "./settings-error-message"

const ACTIVE_REGISTRATION = new Set([
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched",
])

// 注册服务只有一个扫码任务；页面退出后也要等待旧任务取消，才能开启新任务。
let registrationOperation: Promise<void> = Promise.resolve()

export function FeishuConnectionDialog({
  open,
  snapshot,
  onOpenChange,
  onConnected,
}: {
  open: boolean
  snapshot: DesktopConnectionsSnapshot | null
  onOpenChange: (open: boolean) => void
  onConnected: (snapshot: DesktopConnectionsSnapshot) => void
}): React.JSX.Element {
  const id = useId()
  const [method, setMethod] = useState<"scan" | "manual">("scan")
  const [attempt, setAttempt] = useState(0)
  const [registration, setRegistration] = useState<DesktopFeishuRegistrationSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [synced, setSynced] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [manualBusy, setManualBusy] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [manual, setManual] = useState({
    appId: "",
    appSecret: "",
    domain: "feishu" as ChannelDomain,
  })

  useEffect(() => {
    if (!open || method !== "scan") return
    const connections = window.desktop.connections
    let cancelled = false
    let started = false
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const accept = async (value: DesktopFeishuRegistrationSnapshot): Promise<void> => {
      if (cancelled) return
      finished = !ACTIVE_REGISTRATION.has(value.state)
      setRegistration(value)
      if (value.state === "succeeded") {
        const next = await connections.snapshot()
        if (cancelled) return
        onConnected(next)
        setSynced(true)
        setError(null)
      }
    }
    const poll = async (): Promise<void> => {
      try {
        await accept(await connections.registrationStatus())
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause))
      } finally {
        if (!cancelled && !finished) timer = setTimeout(poll, 1000)
      }
    }
    const starting = registrationOperation
      .catch(() => {})
      .then(async () => {
        if (cancelled) return
        started = true
        await accept(await connections.startRegistration({ domain: "feishu" }))
        if (!cancelled && !finished) timer = setTimeout(poll, 1000)
      })
    registrationOperation = starting
    void starting.catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause))
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      registrationOperation = starting
        .catch(() => {})
        .then(async () => {
          if (started && !finished) await connections.cancelRegistration()
        })
      // 手动连接等待这个 Promise 并显示取消失败；卸载时避免未处理的错误。
      void registrationOperation.catch(() => {})
    }
  }, [open, method, attempt, onConnected])

  const changeOpen = (next: boolean): void => {
    if (manualBusy || refreshing) return
    if (!next) {
      setMethod("scan")
      setRegistration(null)
      setError(null)
      setSynced(false)
      setShowSecret(false)
      setManual({ appId: "", appSecret: "", domain: "feishu" })
    }
    onOpenChange(next)
  }
  const changeMethod = (next: string | null): void => {
    if (manualBusy) return
    setMethod(next ? "manual" : "scan")
    setRegistration(null)
    setError(null)
    setSynced(false)
    setShowSecret(false)
    setManual((current) => ({ ...current, appSecret: "" }))
  }
  const retryScan = (): void => {
    setRegistration(null)
    setError(null)
    setSynced(false)
    setAttempt((value) => value + 1)
  }
  const refreshConnection = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      onConnected(await window.desktop.connections.snapshot())
      setSynced(true)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRefreshing(false)
    }
  }
  const submitManual = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (manualBusy || !manual.appId.trim() || !manual.appSecret) return
    const input = { ...manual, appId: manual.appId.trim() }
    setManual((current) => ({ ...current, appSecret: "" }))
    setManualBusy(true)
    setError(null)
    try {
      await registrationOperation
      onConnected(await window.desktop.connections.connect(input))
      setMethod("scan")
      setManual({ appId: "", appSecret: "", domain: "feishu" })
      setShowSecret(false)
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setManualBusy(false)
    }
  }
  const openAuthorization = async (): Promise<void> => {
    if (!registration?.qrUrl) return
    try {
      await window.desktop.window.openExternal(registration.qrUrl)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const succeeded = registration?.state === "succeeded"
  const expired = registration?.state === "expired"
  const terminal = registration && !ACTIVE_REGISTRATION.has(registration.state)
  const runtime = snapshot?.runtime.connectors.find((item) => item.connector === "feishu")
  const channelName = registration?.domain === "lark" ? "Lark" : "飞书"
  const remaining = registration?.remainingSeconds
  const countdown =
    remaining === undefined
      ? null
      : Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0")
  const manualForm = (
    <form onSubmit={(event) => void submitManual(event)} className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        适合已有自建应用。先在开放平台开启机器人和消息接收，再填写凭据。
      </p>
      <FieldGroup>
        <Field data-disabled={manualBusy}>
          <FieldLabel htmlFor={id + "-app-id"}>App ID</FieldLabel>
          <Input
            id={id + "-app-id"}
            aria-label="App ID"
            placeholder="cli_…"
            autoComplete="off"
            spellCheck={false}
            disabled={manualBusy}
            value={manual.appId}
            onChange={(event) => setManual((value) => ({ ...value, appId: event.target.value }))}
          />
        </Field>
        <Field data-disabled={manualBusy}>
          <FieldLabel htmlFor={id + "-secret"}>App Secret</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={id + "-secret"}
              aria-label="App Secret"
              type={showSecret ? "text" : "password"}
              placeholder="输入应用密钥"
              autoComplete="off"
              spellCheck={false}
              disabled={manualBusy}
              value={manual.appSecret}
              onChange={(event) =>
                setManual((value) => ({ ...value, appSecret: event.target.value }))
              }
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={showSecret ? "隐藏密钥" : "显示密钥"}
                disabled={manualBusy}
                onClick={() => setShowSecret((value) => !value)}
              >
                {showSecret ? <EyeOff /> : <Eye />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor={id + "-region"}>服务地区</FieldLabel>
          <Select
            value={manual.domain}
            disabled={manualBusy}
            onValueChange={(value) =>
              setManual((current) => ({ ...current, domain: value === "lark" ? "lark" : "feishu" }))
            }
          >
            <SelectTrigger id={id + "-region"} aria-label="服务地区">
              <SelectValue>
                {manual.domain === "lark" ? "Lark（国际版）" : "飞书（中国大陆）"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="feishu">飞书（中国大陆）</SelectItem>
                <SelectItem value="lark">Lark（国际版）</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>接入后请在访问权限中添加允许使用的用户或群聊。</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          shape="pill"
          disabled={manualBusy}
          onClick={() => changeMethod(null)}
        >
          <QrCode data-icon="inline-start" />
          返回扫码接入
        </Button>
        <StatefulButton
          type="submit"
          size="sm"
          pressScale={1}
          state={manualBusy ? "loading" : "idle"}
          loadingText="验证连接中"
          disabled={manualBusy || !manual.appId.trim() || !manual.appSecret}
        >
          验证并连接
        </StatefulButton>
      </div>
    </form>
  )

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-3rem)] gap-5 overflow-y-auto p-6 sm:max-w-[38rem]"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <FeishuConnectionIcon />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle>连接{channelName}</DialogTitle>
              <DialogDescription>扫码创建机器人，在聊天中使用 Vykor。</DialogDescription>
            </div>
            <Button
              size="icon-sm"
              shape="circle"
              variant="ghost"
              aria-label="关闭连接弹窗"
              disabled={manualBusy || refreshing}
              onClick={() => changeOpen(false)}
            >
              <X />
            </Button>
          </div>
        </DialogHeader>
        {error || (registration?.error && !expired) ? (
          <Alert variant="destructive">
            <Info />
            <AlertTitle>{error ?? registration?.error?.message}</AlertTitle>
            {succeeded && !synced ? (
              <AlertDescription>机器人已创建，请重新读取连接状态。</AlertDescription>
            ) : null}
          </Alert>
        ) : null}
        {succeeded ? (
          <div className="flex flex-col items-center gap-4 py-5 text-center" aria-live="polite">
            <CircleCheck className="size-9" strokeWidth={1.75} />
            <h3 className="text-base font-semibold">
              {synced && runtime?.state === "running" ? channelName + "已连接" : "机器人已创建"}
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {synced && runtime?.state === "running"
                ? "打开飞书，给机器人发送第一条消息。"
                : synced && runtime?.lastError
                  ? runtime.lastError
                  : "凭据已保存，正在确认连接状态。"}
            </p>
            {snapshot?.feishu.botName && synced ? (
              <p className="text-sm font-medium">{snapshot.feishu.botName}</p>
            ) : null}
            {registration?.warning ? (
              <Alert>
                <ShieldCheck />
                <AlertDescription>{registration.warning}</AlertDescription>
              </Alert>
            ) : null}
            {synced ? (
              <Button shape="pill" onClick={() => changeOpen(false)}>
                完成
              </Button>
            ) : (
              <StatefulButton
                size="sm"
                pressScale={1}
                state={refreshing ? "loading" : "idle"}
                loadingText="读取中"
                onClick={() => void refreshConnection()}
              >
                重新读取状态
              </StatefulButton>
            )}
          </div>
        ) : (
          <>
            {method === "scan" ? (
              <div className="flex flex-col gap-5">
                <div className="grid gap-6 sm:grid-cols-[1fr_13rem]">
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <h3 className="text-sm font-semibold">用{channelName}扫一扫</h3>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        扫描二维码，在飞书页面确认创建和授权。完成后，这里会自动连接。
                      </p>
                    </div>
                    <ol className="flex flex-col gap-4">
                      {[
                        ["打开飞书扫一扫", "在飞书首页找到扫一扫。"],
                        ["确认创建与授权", "根据飞书页面提示完成操作。"],
                        ["给机器人发消息", "在私聊或群聊中继续对话。"],
                      ].map(([title, description], index) => (
                        <li key={title} className="flex items-start gap-2.5">
                          <span className="grid size-5 shrink-0 place-items-center rounded-full border text-xs text-muted-foreground">
                            {index + 1}
                          </span>
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold">{title}</span>
                            <span className="text-xs text-muted-foreground">{description}</span>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                      扫码后默认仅允许授权者本人使用。
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-3">
                    {expired || terminal || (error && !registration?.qrUrl) ? (
                      <div className="flex size-48 flex-col items-center justify-center gap-3 rounded-xl border">
                        <Clock3 className="size-6 text-muted-foreground" />
                        <p className="text-xs">{expired ? "二维码已过期" : "扫码接入已结束"}</p>
                        <Button size="sm" shape="pill" onClick={retryScan}>
                          <RefreshCw data-icon="inline-start" />
                          重新生成
                        </Button>
                      </div>
                    ) : registration?.qrDataUrl ? (
                      <img
                        src={registration.qrDataUrl}
                        alt="飞书接入二维码"
                        className="size-48 rounded-xl border bg-white p-2"
                      />
                    ) : (
                      <div
                        className="flex size-48 flex-col items-center justify-center gap-3 rounded-xl border"
                        role="status"
                      >
                        {registration?.qrUrl ? (
                          <>
                            <QrCode className="size-7 text-muted-foreground" />
                            <span className="px-4 text-center text-xs text-muted-foreground">
                              二维码暂不可用，请在浏览器继续。
                            </span>
                          </>
                        ) : (
                          <>
                            <Spinner />
                            <span className="text-xs text-muted-foreground">正在准备二维码…</span>
                          </>
                        )}
                      </div>
                    )}
                    {!terminal ? (
                      <p
                        className="flex items-center gap-3 text-xs text-muted-foreground"
                        role="status"
                      >
                        <span>
                          {registration?.state === "domain_switched"
                            ? "正在切换至 Lark 授权"
                            : registration?.qrUrl
                              ? "等待扫码授权"
                              : "正在准备授权"}
                        </span>
                        {countdown ? <span className="tabular-nums">{countdown}</span> : null}
                      </p>
                    ) : null}
                    {registration?.qrUrl && !terminal ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="pill"
                        onClick={() => void openAuthorization()}
                      >
                        <ExternalLink data-icon="inline-start" />
                        在浏览器继续
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Separator />
                <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  无需复制 App ID 和密钥，授权后自动保存到本机。
                </p>
              </div>
            ) : null}
            <BouncyAccordion
              value={method === "manual" ? "manual" : null}
              onValueChange={changeMethod}
              classNames={{
                item: "rounded-none! bg-transparent!",
                trigger: "px-0 gap-2.5 min-h-12 focus-visible:ring-2 focus-visible:ring-ring",
                title: "text-sm",
                icon: "size-4",
                description: "text-xs",
                content: "[&>div]:px-0",
              }}
              items={[
                {
                  id: "manual",
                  title: "使用已有应用手动连接",
                  icon: <KeyRound className="size-4" />,
                  disabled: manualBusy,
                  description: method === "manual" ? manualForm : null,
                },
              ]}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
