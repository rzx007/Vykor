import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { Button } from "@renderer/components/ui/button"
import { Checkbox } from "@renderer/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { isDesktopLinkOpeningMode, type DesktopLinkOpeningMode } from "@shared/settings-types"

type BrowserTarget = Exclude<DesktopLinkOpeningMode, "ask">

export function MessageLinkOpening({
  children,
  scopeId,
  onOpenBrowser,
}: {
  children: ReactNode
  scopeId: string
  onOpenBrowser: (url: string) => void
}) {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const [target, setTarget] = useState<BrowserTarget>("builtin")
  const [remember, setRemember] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previousScope, setPreviousScope] = useState(scopeId)
  const rememberId = useId()
  const requestVersion = useRef(0)
  const busy = useRef(false)

  if (scopeId !== previousScope) {
    setPreviousScope(scopeId)
    setPendingUrl(null)
    setSubmitting(false)
  }

  useLayoutEffect(() => {
    const version = requestVersion
    version.current++
    busy.current = false
    return () => {
      version.current++
    }
  }, [scopeId])

  async function open(browser: BrowserTarget, url: string) {
    if (browser === "builtin") onOpenBrowser(url)
    else await window.desktop.window.openExternal(url)
  }

  async function request(url: string) {
    if (busy.current || pendingUrl) return
    busy.current = true
    const version = ++requestVersion.current
    try {
      const preference = await window.desktop.settings.getLinkOpeningMode()
      if (version !== requestVersion.current) return
      const mode = isDesktopLinkOpeningMode(preference) ? preference : "ask"
      if (mode !== "ask") {
        await open(mode, url)
        return
      }
      setTarget("builtin")
      setRemember(false)
      setError(null)
      setPendingUrl(url)
    } catch (failure) {
      if (version !== requestVersion.current) return
      setTarget("builtin")
      setRemember(false)
      setError(failure instanceof Error ? failure.message : "无法读取或打开链接，请重新选择。")
      setPendingUrl(url)
    } finally {
      if (version === requestVersion.current) busy.current = false
    }
  }

  function handleLink(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return
    const anchor =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>(
            '[data-message-web-links="true"] a[data-streamdown="link"]'
          )
        : null
    if (!anchor) return
    try {
      const url = new URL(anchor.href)
      if (url.protocol !== "https:" && url.protocol !== "http:") return
      event.preventDefault()
      event.stopPropagation()
      void request(url.href)
    } catch {
      event.preventDefault()
      // 消息中的无效地址不能退回原生导航。
    }
  }

  async function confirm() {
    if (!pendingUrl || busy.current) return
    busy.current = true
    setSubmitting(true)
    setError(null)
    const version = ++requestVersion.current
    try {
      if (remember) await window.desktop.settings.updateLinkOpeningMode({ linkOpeningMode: target })
      if (version !== requestVersion.current) return
      await open(target, pendingUrl)
      if (version === requestVersion.current) setPendingUrl(null)
    } catch (failure) {
      if (version === requestVersion.current) {
        setError(failure instanceof Error ? failure.message : "无法保存或打开链接，请重试。")
      }
    } finally {
      if (version === requestVersion.current) {
        busy.current = false
        setSubmitting(false)
      }
    }
  }

  return (
    <div className="contents" onClickCapture={handleLink} onAuxClickCapture={handleLink}>
      {children}
      <Dialog
        open={pendingUrl !== null}
        onOpenChange={(value) => {
          if (!value && !submitting) setPendingUrl(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>打开链接</DialogTitle>
            <DialogDescription>选择用于打开这个网页的浏览器。</DialogDescription>
          </DialogHeader>
          <p className="max-h-24 overflow-auto text-xs break-all text-muted-foreground">
            {pendingUrl}
          </p>
          <Select
            value={target}
            disabled={submitting}
            onValueChange={(value) => {
              if (value === "builtin" || value === "system") setTarget(value)
            }}
          >
            <SelectTrigger aria-label="打开方式">
              <SelectValue>
                {target === "builtin" ? "Vykor 内置浏览器" : "系统默认浏览器"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="builtin">Vykor 内置浏览器</SelectItem>
              <SelectItem value="system">系统默认浏览器</SelectItem>
            </SelectContent>
          </Select>
          <label htmlFor={rememberId} className="flex items-center gap-2">
            <Checkbox
              id={rememberId}
              checked={remember}
              disabled={submitting}
              onCheckedChange={setRemember}
            />
            记住我的选择
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              shape="pill"
              disabled={submitting}
              onClick={() => setPendingUrl(null)}
            >
              取消
            </Button>
            <Button shape="pill" disabled={submitting} onClick={() => void confirm()}>
              {submitting ? "正在打开…" : "打开"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
