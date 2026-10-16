import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { FileContents } from "@pierre/diffs"
import type { FileRendererInstance } from "@pierre/diffs/worker"
import { createStreamingCodeHighlighter } from "./streaming-code-highlighter"

function setup() {
  const requests: Array<{ instance: FileRendererInstance; file: FileContents }> = []
  const pool = {
    isWorkingPool: () => true,
    cleanUpTasks: vi.fn(),
    highlightFileAST(instance: FileRendererInstance, file: FileContents) {
      requests.push({ instance, file })
    },
  }
  const publish = vi.fn()
  const session = createStreamingCodeHighlighter(pool, publish)
  const finish = (index: number) => {
    const { instance, file } = requests[index]!
    instance.onHighlightSuccess(
      file,
      { code: [], themeStyles: "", baseThemeType: undefined },
      { theme: "pierre-dark", useTokenTransformer: false, tokenizeMaxLineLength: 4000 }
    )
  }
  return { session, requests, publish, finish, pool }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it("bounds requests for sustained streaming without delaying the latest trailing value", () => {
  const { session, requests, finish } = setup()
  session.update("const x = 1;", "typescript", true)
  finish(0)
  for (let index = 1; index <= 100; index++) {
    session.update("const x = 1;" + " ".repeat(index), "typescript", true)
    vi.advanceTimersByTime(10)
    if (requests.length > 1) finish(requests.length - 1)
  }
  vi.advanceTimersByTime(1000)
  expect(requests.length).toBeLessThanOrEqual(8)
  expect(requests.at(-1)?.file.contents).toBe("const x = 1;" + " ".repeat(100))
  expect(requests.every((request) => request.file.cacheKey === undefined)).toBe(true)
  session.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps only one outstanding job per block and uses the newest buffered input", () => {
  const { session, requests, finish } = setup()
  session.update("a", "typescript", true)
  for (let i = 0; i < 100; i++) session.update("a" + "b".repeat(i + 1), "typescript", true)
  vi.advanceTimersByTime(1000)
  expect(requests).toHaveLength(1)
  finish(0)
  expect(requests).toHaveLength(2)
  expect(requests[1].file.contents).toBe("a" + "b".repeat(100))
  session.dispose()
})

it("flushes final code immediately and ignores late results after correction or disposal", () => {
  const { session, requests, finish, publish } = setup()
  session.update("aaa", "typescript", true)
  session.update("bbb", "typescript", true)
  finish(0)
  expect(publish).not.toHaveBeenCalled()
  finish(1)
  expect(publish).toHaveBeenCalledTimes(1)
  session.update("bbb final", "typescript", true)
  expect(requests).toHaveLength(2)
  session.update("bbb final", "typescript", false)
  expect(requests).toHaveLength(3)
  session.dispose()
  finish(2)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps failures readable without repeatedly submitting the same failed input", () => {
  const { session, requests, publish } = setup()
  session.update("source", "unknown-language", true)
  requests[0].instance.onHighlightError(new Error("unavailable"))
  vi.advanceTimersByTime(5000)
  expect(requests).toHaveLength(1)
  expect(publish).not.toHaveBeenCalled()
  session.dispose()
})

it("continues with buffered new code when the previous job fails", () => {
  const { session, requests, finish, publish } = setup()
  session.update("a", "typescript", true)
  session.update("ab", "typescript", true)
  requests[0].instance.onHighlightError(new Error("failed old input"))
  vi.advanceTimersByTime(200)
  expect(requests).toHaveLength(2)
  expect(requests[1].file.contents).toBe("ab")
  finish(1)
  expect(publish).toHaveBeenCalledTimes(1)
  session.dispose()
})
