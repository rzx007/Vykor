import { Link } from "@tanstack/react-router"
import { useLayoutEffect, useRef, useState } from "react"
import type { RichUiContent, RichUiLoadResult } from "@shared/rich-ui-content"
import { Button } from "@renderer/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card"
import { toast } from "@renderer/lib/toast"
import { useInteractiveUiPreference } from "@renderer/stores/interactive-ui-preference"

const contentLabels = {
  image: { action: "加载图片", error: "图片加载失败，请重试。" },
  video: { action: "播放视频", error: "视频加载失败，可以在浏览器打开。" },
  html: { action: "运行 HTML", error: "HTML 加载失败，请重试。" },
}

type LoadState = RichUiLoadResult | { kind: "idle" | "loading" | "error" }
type CardLifetime = { pending: boolean; release?: () => void }

export function RichUiCard({ content }: { content: RichUiContent }) {
  const { enabled, error: preferenceError } = useInteractiveUiPreference("rich")
  const [state, setState] = useState<LoadState>({ kind: "idle" })
  const lifetime = useRef<CardLifetime | null>(null)

  // The caller keys the card by content. Changes to the preference do not replace it.
  useLayoutEffect(() => {
    const current: CardLifetime = { pending: false }
    lifetime.current = current
    return () => {
      lifetime.current = null
      current.release?.()
    }
  }, [])

  const loaded = state.kind === "image" || state.kind === "frame"
  const loading = state.kind === "loading"
  const labels = contentLabels[content.kind]
  const video = content.kind === "video"

  async function loadContent() {
    const current = lifetime.current
    if (!enabled || !current || current.pending || loaded) return
    current.pending = true
    setState({ kind: "loading" })

    try {
      const bridge = window.desktop.richUi
      const result = await bridge.load(content)
      const release =
        result.kind === "frame"
          ? () => void bridge.release(result.mountId).catch(() => undefined)
          : undefined
      if (lifetime.current !== current) {
        release?.()
        return
      }
      current.release = release
      setState(result)
    } catch {
      if (lifetime.current === current) setState({ kind: "error" })
    } finally {
      current.pending = false
    }
  }

  async function openVideo(url: string) {
    try {
      await window.desktop.window.openExternal(new URL(url).href)
    } catch {
      toast.error("无法打开视频，请重试。")
    }
  }

  return (
    <Card size="sm" className="my-3 min-w-0" aria-busy={loading || undefined}>
      <CardHeader>
        <CardTitle className="wrap-anywhere">{content.title}</CardTitle>
        {enabled && content.kind === "image" ? (
          <CardDescription className="wrap-anywhere">
            来源 {new URL(content.url).hostname}
          </CardDescription>
        ) : null}
        {enabled && video && !loaded ? (
          <CardDescription className="wrap-anywhere">
            播放时将连接 {new URL(content.url).hostname}。
          </CardDescription>
        ) : null}
        {enabled && content.kind === "html" && !loaded ? (
          <CardDescription>此页面仅在本机隔离运行，不能联网。</CardDescription>
        ) : null}
        {!loaded && (enabled === false || preferenceError || state.kind === "disabled") ? (
          <CardDescription role="status">
            {preferenceError || "聊天富内容已关闭。"}{" "}
            <Link
              to="/settings/$section"
              params={{ section: "general" }}
              hash="general-rich-ui"
              className="text-primary underline underline-offset-4"
            >
              前往常规设置
            </Link>
          </CardDescription>
        ) : null}
        {enabled && state.kind === "error" ? (
          <CardDescription role="alert">{labels.error}</CardDescription>
        ) : null}
      </CardHeader>
      {loaded ? (
        <CardContent>
          {state.kind === "image" ? (
            <img
              alt={content.title}
              src={state.src}
              onError={() => setState({ kind: "error" })}
              className="max-h-[min(30rem,60dvh)] max-w-full rounded-lg object-contain"
            />
          ) : (
            <iframe
              title={content.title}
              src={`vykor-plugin-app://frame/${state.mountId}`}
              className={
                video ? "aspect-video w-full rounded-lg" : "h-[min(24rem,55dvh)] w-full rounded-lg"
              }
              referrerPolicy="no-referrer"
              sandbox={
                video ? "allow-scripts allow-same-origin allow-presentation" : "allow-scripts"
              }
              allow={video ? "encrypted-media; picture-in-picture" : undefined}
            />
          )}
        </CardContent>
      ) : null}
      {enabled && (!loaded || video) ? (
        <CardContent className="flex flex-wrap gap-2">
          {!loaded ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={loadContent}
            >
              {loading ? "加载中…" : labels.action}
            </Button>
          ) : null}
          {video ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void openVideo(content.url)}
            >
              在浏览器打开
            </Button>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  )
}
