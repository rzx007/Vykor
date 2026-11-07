import { expect, it } from "vitest"
import {
  browserCrashFailure,
  browserHttpFailure,
  browserLoadFailure,
  displayFailureUrl,
} from "../browser-load-failure"

it("distinguishes missing local files from network failures and access denial", () => {
  const file = "file:///C:/reports/report.html"
  expect(browserLoadFailure(file, -6, "ERR_FILE_NOT_FOUND")).toMatchObject({
    kind: "file",
    title: "找不到本地文件",
  })
  expect(browserLoadFailure(file, -10, "ERR_ACCESS_DENIED")).toMatchObject({
    kind: "file",
    title: "无法打开本地文件",
  })
  expect(browserLoadFailure("https://example.com", -101, "ERR_CONNECTION_RESET")).toMatchObject({
    kind: "unknown",
    code: "ERR_CONNECTION_RESET",
  })
})

it("ignores cancellation and successful or non-HTTP responses", () => {
  expect(browserLoadFailure("https://example.com", -3, "ERR_ABORTED")).toBeNull()
  for (const status of [-1, 0, 200, 204, 302, Number.NaN])
    expect(browserHttpFailure("https://example.com", status)).toBeNull()
  expect(browserHttpFailure("file:///C:/report.html", 404)).toBeNull()
})

it("explains authentication, removed pages, rate limits and server errors without losing the status", () => {
  for (const [status, title] of [
    [401, "需要登录后访问"],
    [410, "页面已被移除"],
    [429, "请求过于频繁"],
    [502, "网站暂时不可用"],
  ] as const)
    expect(browserHttpFailure("https://example.com", status)).toMatchObject({
      title,
      code: `HTTP ${status}`,
    })
})

it("shows security failures without suggesting bypass and explains out of memory", () => {
  expect(browserLoadFailure("https://example.com", -107, "ERR_SSL_PROTOCOL_ERROR")).toMatchObject({
    kind: "security",
  })
  expect(browserCrashFailure("https://example.com", "oom").description).toContain("内存")
})

it("decodes local file paths and removes URL credentials from the error display", () => {
  expect(displayFailureUrl("file:///C:/reports/%E6%8A%A5%E5%91%8A%20%231.svg")).toBe(
    "C:/reports/报告 #1.svg"
  )
  expect(displayFailureUrl("https://user:secret@example.com/path")).toBe("https://example.com/path")
  expect(displayFailureUrl("not a URL")).toBe("not a URL")
})
