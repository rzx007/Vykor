import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ModelRetryNotice } from "../model-retry-notice"

const retry = {
  generationId: "g1",
  attempt: 1,
  retryNumber: 2,
  maxRetries: 5,
  reason: "network" as const,
  nextRetryAt: 10_000,
  recoveryDeadlineAt: 180_000,
}

describe("ModelRetryNotice", () => {
  it("shows a countdown before the next attempt", () => {
    const html = renderToStaticMarkup(
      createElement(ModelRetryNotice, { retry, now: 8_000 })
    )
    expect(html).toContain("连接中断，2 秒后重试（第 2/5 次）")
    expect(html).toContain('role="status"')
  })

  it("switches to reconnecting once the wait has elapsed", () => {
    const html = renderToStaticMarkup(
      createElement(ModelRetryNotice, { retry, now: 10_000 })
    )
    expect(html).toContain("正在重新连接（第 2/5 次）")
  })

  it("never shows a negative countdown", () => {
    const html = renderToStaticMarkup(
      createElement(ModelRetryNotice, { retry, now: 99_000 })
    )
    expect(html).toContain("正在重新连接（第 2/5 次）")
  })
})
