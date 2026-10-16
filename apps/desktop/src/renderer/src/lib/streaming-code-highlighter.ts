import type { FileContents, ThemedFileResult } from "@pierre/diffs"
import type { FileRendererInstance, WorkerPoolManager } from "@pierre/diffs/worker"

export interface CodeHighlightSnapshot {
  file: FileContents
  result: ThemedFileResult
}
type Pool = Pick<WorkerPoolManager, "highlightFileAST" | "cleanUpTasks" | "isWorkingPool">
let nextId = 0

export function createStreamingCodeHighlighter(
  pool: Pool,
  publish: (snapshot: CodeHighlightSnapshot) => void
) {
  let latest: FileContents | undefined
  let inFlight: FileContents | undefined
  let completed: FileContents | undefined
  let streaming = false
  let disposed = false
  let lastDispatch = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const instance: FileRendererInstance = {
    __id: `conversation-code-${++nextId}`,
    onHighlightSuccess(file, result) {
      if (disposed || file !== inFlight) return
      inFlight = undefined
      completed = file
      if (latest && latest.lang === file.lang && latest.contents.startsWith(file.contents))
        publish({ file, result })
      schedule()
    },
    onHighlightError() {
      completed = inFlight
      inFlight = undefined
      // 保留最新源码；失败时不自动重试相同内容，防止阻塞队列。
      schedule()
    },
  }
  function schedule() {
    if (disposed || !latest || latest === completed || inFlight || timer || !pool.isWorkingPool())
      return
    const interval = streaming ? Math.min(1000, Math.max(160, latest.contents.length / 80)) : 0
    const delay = Math.max(0, lastDispatch + interval - performance.now())
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = undefined
        schedule()
      }, delay)
      return
    }
    inFlight = latest
    lastDispatch = performance.now()
    try {
      pool.highlightFileAST(instance, latest)
    } catch {
      instance.onHighlightError(new Error("Code highlighting unavailable"))
    }
  }
  return {
    update(code: string, language: string, active: boolean) {
      if (disposed) return
      const corrected = latest && (latest.lang !== language || !code.startsWith(latest.contents))
      const finishing = streaming && !active
      streaming = active
      if (latest?.contents === code && latest.lang === language && !finishing) return
      // 无全局 cacheKey：流式中间全文只由本实例持有，不进入共享 AST 缓存。
      latest = {
        name: `snippet.${language}`,
        lang: language as FileContents["lang"],
        contents: code,
      }
      if (corrected || finishing) {
        clearTimer()
        pool.cleanUpTasks(instance)
        inFlight = undefined
        lastDispatch = Number.NEGATIVE_INFINITY
      }
      schedule()
    },
    dispose() {
      disposed = true
      clearTimer()
      pool.cleanUpTasks(instance)
      latest = inFlight = completed = undefined
    },
  }
}
