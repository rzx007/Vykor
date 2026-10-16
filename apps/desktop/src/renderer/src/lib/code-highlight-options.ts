import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from "@pierre/diffs/react"

export const codeHighlighterOptions = {
  preferredHighlighter: "shiki-js",
  tokenizeMaxLineLength: 4_000,
} satisfies WorkerInitializationRenderOptions

export function createCodeHighlightWorkerPoolOptions(
  workerFactory: () => Worker
): WorkerPoolOptions {
  return { poolSize: 1, workerFactory }
}
