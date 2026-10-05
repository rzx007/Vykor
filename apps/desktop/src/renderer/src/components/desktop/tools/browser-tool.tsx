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
import { useBrowserAnnotations } from "./use-browser-annotations"
import { BrowserAnnotationPanel } from "./browser-annotation-panel"

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
  visible: boolean
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

export function BrowserTool({ tab, active, visible, onUpdate }: BrowserToolProps): React.JSX.Element {
  const webviewRef = useRef<BrowserWebviewElement | null>(null)
  const webviewReadyRef = useRef(false)
  const activeRef = useRef(active)
  const onUpdateRef = useRef(onUpdate)
  const [browserError, setBrowserError] = useState<string | null>(null)
  const pageContainer = useRef<HTMLDivElement | null>(null)
  const annotation = useBrowserAnnotations({ tabId: tab.id, visible, ready: webviewReadyRef.current && !tab.loading && Boolean(tab.url) })
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
  const scrollbarStyleRef = useRef(applyScrollbarStyle)
  scrollbarStyleRef.current = applyScrollbarStyle

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
    if (url === "about:blank" && !tab.url) return
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
        // React calls the ref with null after detaching the <webview>; Electron methods can throw at that point.
        if (previous) {
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
        scrollbarStyleRef.current(webview)
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
              setBrowserError(error instanceof Error ? error.message : String(error))
            )
        }
      })
      webview.addEventListener("did-start-loading", () => {
        onUpdateRef.current({ loading: true })
      })
      webview.addEventListener("did-stop-loading", () => {
        scrollbarStyleRef.current(webview)
        updateNavigationState()
      })
      webview.addEventListener("did-navigate", updateNavigationState)
      webview.addEventListener("did-navigate-in-page", updateNavigationState)
      webview.addEventListener("page-title-updated", (event) => {
        const title = (event as Event & { title?: string }).title
        if (title) onUpdateRef.current({ title })
      })
    },
    [tab.id]
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
          variant={annotation.snapshot?.mode && annotation.snapshot.mode !== "off" ? "secondary" : "ghost"}
          size="icon"
          title="选择页面元素添加批注"
          aria-label="选择页面元素添加批注"
          aria-pressed={annotation.snapshot?.mode === "pick"}
          disabled={!tab.url || tab.loading || annotation.pending}
          onClick={() => void (annotation.snapshot?.mode === "pick" ? annotation.showSaved() : annotation.startPicking())}
          className="shrink-0 text-muted-foreground"
        >
          <MessageSquareText />
        </Button>
        {Boolean(annotation.snapshot?.annotations.length) && <Button type="button" variant="ghost" size="sm" aria-label="查看已保存批注" disabled={annotation.pending} onClick={() => void annotation.showSaved()}>
          {annotation.snapshot!.annotations.length}
        </Button>}
      </div>

      <div ref={pageContainer} className="relative min-h-0 flex-1 bg-background">
        <webview
          {...{
            ref: bindWebview,
            src: tab.url ?? "about:blank",
            partition: "persist:vykor-browser",
            className: "h-full w-full bg-background",
          }}
        />
        {!tab.url && (
          <div className="absolute inset-0 bg-background">
            <DesktopEmptyState icon={Globe2} title="开始浏览" description="输入 URL 以打开页面" />
          </div>
        )}
        {tab.url && visible && <BrowserAnnotationPanel ui={annotation} containerRef={pageContainer} />}
        {browserError && (
          <p
            role="status"
            className="absolute bottom-3 left-3 z-20 max-w-[80%] rounded-lg border bg-background px-3 py-2 text-xs text-destructive shadow-sm"
          >
            {browserError}
          </p>
        )}
      </div>
    </section>
  )
}
