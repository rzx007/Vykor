import { describe, expect, it } from "vitest"

import {
  codeHighlighterOptions,
  createCodeHighlightWorkerPoolOptions,
} from "./code-highlight-options"

describe("shared code highlighting worker options", () => {
  it("uses one worker and preserves the supplied factory", () => {
    const worker = {} as Worker
    let factoryCalls = 0
    const options = createCodeHighlightWorkerPoolOptions(() => {
      factoryCalls += 1
      return worker
    })

    expect(options.poolSize).toBe(1)
    expect(options.workerFactory()).toBe(worker)
    expect(factoryCalls).toBe(1)
  })

  it("limits syntax analysis for pathological lines", () => {
    expect(codeHighlighterOptions).toMatchObject({
      preferredHighlighter: "shiki-js",
      tokenizeMaxLineLength: 4_000,
    })
  })
})
