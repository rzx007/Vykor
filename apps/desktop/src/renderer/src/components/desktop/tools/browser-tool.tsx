import type * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Download,
  Globe2,
  MessageCircleMore,
  MousePointer2,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import type { NativeImage } from "electron"
import { useCallback, useEffect, useRef, useState } from "react"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { Separator } from "@renderer/components/ui/separator"
import { cn } from "@renderer/lib/utils"
import { isSafeImagePreviewLayout } from "@shared/safe-image-preview"
import { useImageViewer } from "../image-viewer/image-viewer-provider"
import type { ImageSource } from "../image-viewer/image-source"

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
  capturePage?: () => Promise<NativeImage>
}

export function BrowserTool({
  tab,
  active,
  visible,
  onUpdate,
}: BrowserToolProps): React.JSX.Element {
  const webviewRef = useRef<BrowserWebviewElement | null>(null)
  const webviewReadyRef = useRef(false)
  const activeRef = useRef(active)
  const onUpdateRef = useRef(onUpdate)
  const [browserError, setBrowserError] = useState<string | null>(null)
  const [pageReady, setPageReady] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [screenshot, setScreenshot] = useState<{
    source: Extract<ImageSource, { kind: "memory" }>
    url: string
  } | null>(null)
  const captureVersion = useRef(0)
  const captureBusy = useRef(false)
  const viewer = useImageViewer()
  const pageContainer = useRef<HTMLDivElement | null>(null)
  const annotation = useBrowserAnnotations({
    tabId: tab.id,
    visible,
    ready: pageReady && !tab.loading && Boolean(tab.url),
  })
  const { resolvedTheme } = useAppearance()

  useEffect(
    () => () => {
      captureVersion.current += 1
    },
    [active, visible, tab.url, tab.loading]
  )

  useEffect(() => {
    if (screenshot) return () => URL.revokeObjectURL(screenshot.url)
    return undefined
  }, [screenshot])

  const canCapture =
    active && visible && pageReady && !tab.loading && Boolean(tab.url && tab.url !== "about:blank")
  const captureScreenshot = async (): Promise<void> => {
    const webview = webviewRef.current
    if (!canCapture || captureBusy.current || !webview?.capturePage) return
    const request = captureVersion.current
    captureBusy.current = true
    setCapturing(true)
    setBrowserError(null)
    try {
      // 只截内嵌页面当前可见区域，不包含地址栏和宿主的浮层。
      const image = await webview.capturePage()
      if (request !== captureVersion.current) return
      if (image.isEmpty()) throw new Error("页面尚未就绪，请稍后重试截图")
      const { width, height } = image.getSize()
      if (!isSafeImagePreviewLayout({ width, height, frames: 1 }))
        throw new Error("截图尺寸太大，请缩小浏览器区域后重试")
      const png = image.toPNG()
      if (png.byteLength > 8 * 1024 * 1024) throw new Error("截图超过 8 MB，请缩小浏览器区域后重试")
      // Buffer 可能是大缓冲区的切片；只复制这张 PNG 的字节。
      const bytes = new Uint8Array(png).buffer
      const title = tab.title.replace(/[<>:"/\\|?*]/g, "-").slice(0, 80) || "页面"
      const name = `${title}-截图-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
      const source: Extract<ImageSource, { kind: "memory" }> = {
        kind: "memory",
        id: crypto.randomUUID(),
        name,
        bytes,
        mediaType: "image/png",
      }
      setScreenshot({ source, url: URL.createObjectURL(new Blob([bytes], { type: "image/png" })) })
    } catch (error) {
      if (request === captureVersion.current)
        setBrowserError(error instanceof Error ? error.message : "无法截取当前页面")
    } finally {
      captureBusy.current = false
      setCapturing(false)
    }
  }

  const saveScreenshot = (): void => {
    if (!screenshot) return
    const downloadUrl = URL.createObjectURL(
      new Blob([screenshot.source.bytes], { type: screenshot.source.mediaType })
    )
    const link = document.createElement("a")
    link.href = downloadUrl
    link.download = screenshot.source.name
    link.click()
    // 下载异步读取 Blob，不能跟随缩略图的删除或替换立即释放。
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
  }

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
  useEffect(() => {
    scrollbarStyleRef.current = applyScrollbarStyle
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
    if (url === "about:blank" && !tab.url) {
      onUpdateRef.current({ loading: false })
      return
    }
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
        captureVersion.current += 1
        setPageReady(false)
        onUpdateRef.current({ loading: true })
      })
      webview.addEventListener("did-stop-loading", () => {
        setPageReady(webviewReadyRef.current)
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
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <ButtonGroup variant="toolbar" aria-label="浏览器导航">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            shape="circle"
            title="后退"
            aria-label="后退"
            disabled={!tab.canGoBack}
            onClick={() => getWebview()?.goBack?.()}
          >
            <ArrowLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            shape="circle"
            title="前进"
            aria-label="前进"
            disabled={!tab.canGoForward}
            onClick={() => getWebview()?.goForward?.()}
          >
            <ArrowRight />
          </Button>
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            shape="circle"
            title={tab.loading ? "停止加载" : "刷新"}
            aria-label={tab.loading ? "停止加载" : "刷新"}
            onClick={() => (tab.loading ? getWebview()?.stop?.() : getWebview()?.reload?.())}
          >
            <RefreshCw className={cn(tab.loading && "animate-spin")} />
          </Button>
        </ButtonGroup>

        <Button
          type="button"
          variant="annotation"
          size="lg"
          shape="pill"
          title="选择页面元素添加批注"
          aria-label="选择页面元素添加批注"
          aria-pressed={Boolean(annotation.snapshot?.mode && annotation.snapshot.mode !== "off")}
          disabled={!tab.url || tab.loading || annotation.pending}
          onClick={() =>
            void (annotation.snapshot?.mode === "pick"
              ? annotation.showSaved()
              : annotation.startPicking())
          }
        >
          <MousePointer2 data-icon="inline-start" />
          批注
        </Button>

        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            navigate()
          }}
        >
          <InputGroup shape="pill">
            <InputGroupAddon>
              <SlidersHorizontal strokeWidth={1.75} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="浏览器地址"
              value={tab.input}
              onChange={(event) => onUpdate({ input: event.target.value })}
              placeholder="输入 URL 或本地路径"
              className="text-center"
            />
            <InputGroupAddon align="inline-end">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                shape="circle"
                aria-label="在浏览器中打开"
                title="在浏览器中打开"
                disabled={!externalUrl}
                onClick={openInSystemBrowser}
              >
                <ArrowUpRight />
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </form>
        <Button
          type="button"
          variant="control"
          size="icon-lg"
          shape="circle"
          aria-label="截图"
          aria-busy={capturing}
          title={capturing ? "正在截图…" : "截取当前可见页面"}
          disabled={!canCapture || capturing}
          onClick={() => void captureScreenshot()}
        >
          <Camera />
        </Button>
        {Boolean(annotation.snapshot?.annotations.length) && (
          <Button
            type="button"
            variant="control"
            shape="pill"
            size="lg"
            aria-label="查看已保存批注"
            title="查看已保存批注"
            disabled={annotation.pending}
            onClick={() => void annotation.showSaved()}
          >
            <MessageCircleMore data-icon="inline-start" />
            {annotation.snapshot!.annotations.length}
          </Button>
        )}
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
        {tab.url && visible && (
          <BrowserAnnotationPanel ui={annotation} containerRef={pageContainer} />
        )}
        {screenshot && active && visible && (
          <aside
            aria-label="页面截图预览"
            className="absolute top-3 right-3 z-20 flex w-44 flex-col gap-2 rounded-2xl bg-popover p-2 text-popover-foreground shadow-md"
          >
            <button
              type="button"
              aria-label="查看截图并批注"
              title={screenshot.source.name}
              disabled={!viewer}
              className="overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => viewer?.openImage(screenshot.source)}
            >
              <img src={screenshot.url} alt="页面截图" className="h-24 w-full object-contain" />
            </button>
            <ButtonGroup variant="toolbar" aria-label="截图操作" className="self-center">
              <Button
                type="button"
                variant="ghost"
                shape="pill"
                size="sm"
                aria-label="查看截图批注"
                title="查看并批注"
                disabled={!viewer}
                onClick={() => viewer?.openImage(screenshot.source)}
              >
                <MessageCircleMore data-icon="inline-start" />
                批注
              </Button>
              <Button
                type="button"
                variant="ghost"
                shape="circle"
                size="icon-sm"
                aria-label="保存截图"
                title="保存 PNG"
                onClick={saveScreenshot}
              >
                <Download />
              </Button>
              <Button
                type="button"
                variant="ghost"
                shape="circle"
                size="icon-sm"
                aria-label="删除截图"
                title="删除截图"
                onClick={() => setScreenshot(null)}
              >
                <Trash2 />
              </Button>
            </ButtonGroup>
          </aside>
        )}
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
