import { lazy, Suspense, type ReactNode } from "react"

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
  return (
    <Suspense fallback={fallback}>
      <InteractiveUiBlock code={source} closed={closed} fallback={fallback} />
    </Suspense>
  )
}
