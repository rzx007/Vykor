import type * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Globe2,
  MessageSquareText,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"

import {
  browserTitleFromUrl,
  displayBrowserUrl,
  normalizeBrowserUrl,
  resolveExternalBrowserUrl,
} from "./browser-navigation"
import { insertWebviewCssWhenReady } from "./browser-webview-css"
import { buildBrowserScrollbarCss } from "./browser-webview-style"

export type BrowserToolTab = {
  id: string
  title: string
  url: string | null
  input: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type BrowserToolProps = {
  tab: BrowserToolTab
  active: boolean
  onUpdate: (patch: Partial<BrowserToolTab>) => void
}

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  stop?: () => void
  getURL?: () => string
  getTitle?: () => string
  insertCSS?: (css: string) => Promise<string>
  getWebContentsId?: () => number
}

export function BrowserTool({ tab, active, onUpdate }: BrowserToolProps): React.JSX.Element {
  const webviewRef = useRef<BrowserWebviewElement | null>(null)
  const webviewReadyRef = useRef(false)
  const activeRef = useRef(active)
  const onUpdateRef = useRef(onUpdate)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotationTarget, setAnnotationTarget] = useState("")
  const [annotationComment, setAnnotationComment] = useState("")
  const [annotationError, setAnnotationError] = useState<string | null>(null)
  const [savedAnnotationCount, setSavedAnnotationCount] = useState(0)
  const { resolvedTheme } = useAppearance()

  useEffect(() => {
    activeRef.current = active
  }, [active])
  useEffect(() => {
    onUpdateRef.current = onUpdate
  }, [onUpdate])

  const applyScrollbarStyle = useCallback(
    (webview: BrowserWebviewElement): void => {
      insertWebviewCssWhenReady(
        webview,
        buildBrowserScrollbarCss(resolvedTheme),
        webviewReadyRef.current
      )
    },
    [resolvedTheme]
  )

  useEffect(() => {
    const webview = webviewRef.current
    if (webview) applyScrollbarStyle(webview)
  }, [applyScrollbarStyle])

  const navigate = (): void => {
    const url = normalizeBrowserUrl(tab.input)
    if (!url) return
    onUpdate({
      url,
      input: displayBrowserUrl(url),
      title: browserTitleFromUrl(url),
      loading: true,
    })
  }

  const updateNavigationState = (): void => {
    const webview = webviewRef.current
    if (!webview) return
    const url = webview.getURL?.() ?? null
    const title = webview.getTitle?.() || (url ? browserTitleFromUrl(url) : "新标签页")
    onUpdate({
      title,
      url,
      input: url ? displayBrowserUrl(url) : "",
      loading: false,
      canGoBack: webview.canGoBack?.() ?? false,
      canGoForward: webview.canGoForward?.() ?? false,
    })
  }

  const bindWebview = useCallback(
    (element: Element | null): void => {
      const webview = element as BrowserWebviewElement | null
      if (!webview) {
        const previous = webviewRef.current
        const webContentsId = previous?.getWebContentsId?.()
        if (webContentsId !== undefined) {
          void window.desktop.browser
            .updateTab({ action: "unbind", tabId: tab.id })
            .catch(() => undefined)
        }
        webviewRef.current = null
        webviewReadyRef.current = false
        return
      }
      if (webviewRef.current === webview) return
      webviewRef.current = webview
      webviewReadyRef.current = false

      webview.addEventListener("dom-ready", () => {
        webviewReadyRef.current = true
        applyScrollbarStyle(webview)
        const webContentsId = webview.getWebContentsId?.()
        if (webContentsId !== undefined) {
          void window.desktop.browser
            .updateTab({ action: "bind", tabId: tab.id, webContentsId })
            .then(async () => {
              if (activeRef.current) {
                await window.desktop.browser.updateTab({ action: "active", tabId: tab.id })
              }
            })
            .catch((error: unknown) =>
              setAnnotationError(error instanceof Error ? error.message : String(error))
            )
        }
      })
      webview.addEventListener("did-start-loading", () => {
        onUpdateRef.current({ loading: true })
      })
      webview.addEventListener("did-stop-loading", () => {
        applyScrollbarStyle(webview)
        updateNavigationState()
      })
      webview.addEventListener("did-navigate", updateNavigationState)
      webview.addEventListener("did-navigate-in-page", updateNavigationState)
      webview.addEventListener("page-title-updated", (event) => {
        const title = (event as Event & { title?: string }).title
        if (title) onUpdateRef.current({ title })
      })
    },
    [applyScrollbarStyle, tab.id]
  )

  useEffect(() => {
    if (active && webviewReadyRef.current) {
      void window.desktop.browser
        .updateTab({ action: "active", tabId: tab.id })
        .catch(() => undefined)
    }
  }, [active, tab.id])

  const getWebview = (): BrowserWebviewElement | null => webviewRef.current
  const externalUrl = resolveExternalBrowserUrl(tab.url ?? tab.input)

  const openInSystemBrowser = (): void => {
    if (!externalUrl) return
    void window.desktop.window.openExternal(externalUrl)
  }

  return (
    <section
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 flex h-full min-h-0 flex-col bg-conversation transition-opacity duration-100",
        !active && "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="后退"
          aria-label="后退"
          disabled={!tab.canGoBack}
          onClick={() => getWebview()?.goBack?.()}
          className="text-muted-foreground"
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="前进"
          aria-label="前进"
          disabled={!tab.canGoForward}
          onClick={() => getWebview()?.goForward?.()}
          className="text-muted-foreground"
        >
          <ArrowRight />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={tab.loading ? "停止加载" : "刷新"}
          aria-label={tab.loading ? "停止加载" : "刷新"}
          onClick={() => (tab.loading ? getWebview()?.stop?.() : getWebview()?.reload?.())}
          className="text-muted-foreground"
        >
          <RefreshCw className={cn(tab.loading && "animate-spin")} />
        </Button>

        <form
          className="mx-3 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 focus-within:bg-muted/80"
          onSubmit={(event) => {
            event.preventDefault()
            navigate()
          }}
        >
          <SlidersHorizontal className="size-4 shrink-0 text-ui-muted" strokeWidth={1.7} />
          <input
            value={tab.input}
            onChange={(event) => onUpdate({ input: event.target.value })}
            placeholder="输入 URL 或本地路径"
            className="h-full min-w-0 flex-1 bg-transparent text-center text-sm text-ui-foreground outline-none placeholder:text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="在浏览器中打开"
            title="在浏览器中打开"
            disabled={!externalUrl}
            className="text-muted-foreground hover:bg-background"
            onClick={openInSystemBrowser}
          >
            <ArrowUpRight />
          </Button>
        </form>
        <Button
          type="button"
          variant={annotationMode ? "secondary" : "ghost"}
          size="icon"
          title={annotationMode ? "退出标注" : "给页面添加标注"}
          aria-label={annotationMode ? "退出标注" : "给页面添加标注"}
          aria-pressed={annotationMode}
          disabled={!tab.url}
          onClick={() => {
            setAnnotationError(null)
            setAnnotationTarget("")
            setAnnotationMode((value) => !value)
          }}
          className="shrink-0 text-muted-foreground"
        >
          <MessageSquareText />
          {savedAnnotationCount > 0 && (
            <span className="sr-only">已保存 {savedAnnotationCount} 条标注</span>
          )}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 bg-background">
        {tab.url ? (
          <webview
            {...{
              ref: bindWebview,
              src: tab.url,
              partition: "persist:openharness-browser",
              className: "h-full w-full bg-background",
            }}
          />
        ) : (
          <DesktopEmptyState icon={Globe2} title="开始浏览" description="输入 URL 以打开页面" />
        )}
        {tab.url && annotationMode && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair bg-transparent"
            aria-label="点击页面元素添加标注"
            onClick={(event) => {
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              setAnnotationError(null)
              void window.desktop.browser
                .inspectAt({
                  tabId: tab.id,
                  x: event.clientX - bounds.left,
                  y: event.clientY - bounds.top,
                })
                .then(setAnnotationTarget)
                .catch((error: unknown) =>
                  setAnnotationError(error instanceof Error ? error.message : String(error))
                )
            }}
          >
            <div className="absolute top-3 left-3 rounded-lg border bg-background/95 px-3 py-2 text-xs text-foreground shadow-sm">
              点击需要反馈的页面元素
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="退出标注"
                className="ml-2"
                onClick={(event) => {
                  event.stopPropagation()
                  setAnnotationMode(false)
                }}
              >
                ×
              </Button>
            </div>
            {annotationTarget && (
              <form
                className="absolute top-14 left-3 w-[min(22rem,calc(100%-1.5rem))] cursor-auto rounded-xl border bg-background p-3 shadow-lg"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault()
                  const comment = annotationComment.trim()
                  if (!comment) return
                  void window.desktop.browser
                    .addAnnotation({ tabId: tab.id, target: annotationTarget, comment })
                    .then(() => {
                      setSavedAnnotationCount((count) => count + 1)
                      setAnnotationTarget("")
                      setAnnotationComment("")
                      setAnnotationMode(false)
                    })
                    .catch((error: unknown) =>
                      setAnnotationError(error instanceof Error ? error.message : String(error))
                    )
                }}
              >
                <p className="mb-2 truncate text-xs text-muted-foreground">{annotationTarget}</p>
                <label className="sr-only" htmlFor={`browser-annotation-${tab.id}`}>
                  标注内容
                </label>
                <textarea
                  id={`browser-annotation-${tab.id}`}
                  autoFocus
                  value={annotationComment}
                  onChange={(event) => setAnnotationComment(event.target.value)}
                  placeholder="描述希望怎么调整…"
                  className="min-h-20 w-full resize-y rounded-lg border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setAnnotationTarget("")}
                  >
                    取消
                  </Button>
                  <Button type="submit" size="sm" disabled={!annotationComment.trim()}>
                    保存标注
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
        {annotationError && (
          <p
            role="status"
            className="absolute bottom-3 left-3 z-20 max-w-[80%] rounded-lg border bg-background px-3 py-2 text-xs text-destructive shadow-sm"
          >
            {annotationError}
          </p>
        )}
      </div>
    </section>
  )
}
