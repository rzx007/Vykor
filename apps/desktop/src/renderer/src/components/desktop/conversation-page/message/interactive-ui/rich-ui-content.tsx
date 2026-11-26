import { Link } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
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
import { RichUiPreview } from "./rich-ui-preview"

const contentLabels = {
  image: { loading: "正在加载图片…", error: "图片加载失败。" },
  video: { loading: "正在加载视频…", error: "视频加载失败，可以在浏览器打开。" },
  html: { loading: "正在加载 HTML 预览…", error: "HTML 预览加载失败。" },
}

type LoadState = RichUiLoadResult | { kind: "idle" | "error" }
type CardLifetime = { requested: boolean; release?: () => void }

export function RichUiCard({ content }: { content: RichUiContent }) {
  const { enabled, error: preferenceError } = useInteractiveUiPreference("rich")
  const [state, setState] = useState<LoadState>({ kind: "idle" })
  const card = useRef<HTMLDivElement>(null)
  const lifetime = useRef<CardLifetime | null>(null)

  // The caller keys the card by content. Changes to the preference do not replace it.
  useLayoutEffect(() => {
    const current: CardLifetime = { requested: false }
    lifetime.current = current
    return () => {
      lifetime.current = null
      current.release?.()
    }
  }, [])

  useEffect(() => {
    const current = lifetime.current
    const element = card.current
    if (!enabled || !current || !element || current.requested) return
    let observing = true

    const loadPreview = async () => {
      if (!observing || current.requested) return
      current.requested = true
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
        if (result.kind === "disabled") current.requested = false
        setState(result)
      } catch {
        if (lifetime.current === current) setState({ kind: "error" })
      }
    }

    if (typeof IntersectionObserver !== "function") {
      void loadPreview()
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void loadPreview()
    })
    observer.observe(element)
    return () => {
      observing = false
      observer.disconnect()
    }
  }, [content, enabled])

  const loaded = state.kind === "image" || state.kind === "frame"
  const loading = enabled && state.kind === "idle"
  const labels = contentLabels[content.kind]
  const video = content.kind === "video"

  async function openVideo(url: string) {
    try {
      await window.desktop.window.openExternal(new URL(url).href)
    } catch {
      toast.error("无法打开视频，请重试。")
    }
  }

  return (
    <Card ref={card} size="sm" className="my-3 min-w-0">
      <CardHeader>
        <CardTitle className="wrap-anywhere">{content.title}</CardTitle>
        {(enabled || loaded) && content.kind !== "html" ? (
          <CardDescription className="wrap-anywhere">
            来源 {new URL(content.url).hostname}
          </CardDescription>
        ) : null}
        {(enabled || loaded) && content.kind === "html" ? (
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
      {loading || loaded ? (
        <RichUiPreview kind={content.kind} status={loading ? labels.loading : undefined}>
          {state.kind === "image" ? (
            <img
              alt={content.title}
              src={state.src}
              onError={() => setState({ kind: "error" })}
              className="mx-auto block max-h-[min(30rem,60dvh)] max-w-full object-contain"
            />
          ) : state.kind === "frame" ? (
            <iframe
              title={content.title}
              src={`vykor-plugin-app://frame/${state.mountId}`}
              className="absolute inset-0 block size-full"
              referrerPolicy="no-referrer"
              sandbox={
                video ? "allow-scripts allow-same-origin allow-presentation" : "allow-scripts"
              }
              allow={video ? "autoplay 'none'; encrypted-media; picture-in-picture" : undefined}
              {...(video ? { credentialless: "" } : {})}
            />
          ) : null}
        </RichUiPreview>
      ) : null}
      {enabled && video ? (
        <CardContent>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void openVideo(content.url)}
          >
            在浏览器打开
          </Button>
        </CardContent>
      ) : null}
    </Card>
  )
}
