import { lazy, Suspense, type ReactNode } from "react"
import { Card } from "@renderer/components/ui/card"
import { RichUiPreview } from "../interactive-ui/rich-ui-preview"

const partialFenceEnd = /\r?\n[ \t]*`{1,2}[ \t]*$/

const InteractiveUiBlock = lazy(() =>
  import("../interactive-ui/interactive-ui-block").catch(() => ({
    default: ({ fallback }: { fallback: ReactNode }) => fallback,
  }))
)

export function InteractiveUiFence({
  code,
  closed,
  fallback,
}: {
  code: string
  closed: boolean
  fallback: ReactNode
}) {
  const source = closed ? code : code.replace(partialFenceEnd, "")
  const preview = /^root = (Video|HtmlView)\(/.exec(source.trimStart())?.[1]
  const video = preview === "Video"
  const placeholder = preview ? (
    <Card size="sm" className="my-3 min-w-0">
      <RichUiPreview
        kind={video ? "video" : "html"}
        status={video ? "正在生成视频预览…" : "正在生成 HTML 预览…"}
      />
    </Card>
  ) : null

  if (!closed && placeholder) return placeholder

  return (
    <Suspense fallback={placeholder ?? fallback}>
      <InteractiveUiBlock code={source} closed={closed} fallback={fallback} />
    </Suspense>
  )
}
