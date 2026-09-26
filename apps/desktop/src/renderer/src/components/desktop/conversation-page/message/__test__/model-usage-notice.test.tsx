import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { ModelUsageNotice } from "../model-usage-notice"

it("labels known usage as a subtotal and handles wholly unknown usage", () => {
  const metadata = { modelUsage: { incomplete: true, unknownAttempts: 1, partialAttempts: 0 } }
  expect(renderToStaticMarkup(createElement(ModelUsageNotice, { metadata }))).toContain("部分请求用量未知")
  expect(renderToStaticMarkup(createElement(ModelUsageNotice, { metadata: { ...metadata, usage: { inputTokens: 10, outputTokens: 2 } } }))).toContain("已知用量：10 输入 / 2 输出")
  expect(renderToStaticMarkup(createElement(ModelUsageNotice, { metadata: {} }))).toBe("")
})
