import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from "@pierre/diffs/react"

export const codePreviewHighlighterOptions = {
  preferredHighlighter: "shiki-js",
  tokenizeMaxLineLength: 4_000,
} satisfies WorkerInitializationRenderOptions

export function createCodePreviewWorkerPoolOptions(workerFactory: () => Worker): WorkerPoolOptions {
  return { poolSize: 1, workerFactory }
}
