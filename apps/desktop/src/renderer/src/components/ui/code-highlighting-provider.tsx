import { WorkerPoolContextProvider } from "@pierre/diffs/react"
import PierreDiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import type { ReactNode } from "react"
import {
  codePreviewHighlighterOptions,
  createCodePreviewWorkerPoolOptions,
} from "@renderer/lib/code-highlight-options"

const poolOptions = createCodePreviewWorkerPoolOptions(() => new PierreDiffsWorker())

// Pierre 的 provider 共享同一个单线程池；所有代码块和文件预览复用它。
export function CodeHighlightingProvider({ children }: { children: ReactNode }) {
  if (typeof Worker === "undefined") return <>{children}</>
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={codePreviewHighlighterOptions}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}
