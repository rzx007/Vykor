// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { RunErrorNotice } from "../run-error-notice"

describe("RunErrorNotice", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("dismisses only the displayed notice and restores a different error or remounted history", () => {
    const durableRun = Object.freeze({ status: "failed", error: "plugin_initialization_failed" })
    act(() => root.render(createElement(RunErrorNotice, { error: durableRun.error })))
    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="关闭运行错误"]')
    expect(dismiss).not.toBeNull()
    act(() => dismiss!.click())
    expect(container.querySelector("[data-run-error-notice]")).toBeNull()
    expect(durableRun).toEqual({ status: "failed", error: "plugin_initialization_failed" })
    act(() => root.render(createElement(RunErrorNotice, { error: "plugin_permission_required" })))
    expect(container.querySelector("pre")?.textContent).toBe("plugin_permission_required")
    act(() => root.render(null))
    act(() => root.render(createElement(RunErrorNotice, { error: durableRun.error })))
    expect(container.querySelector("pre")?.textContent).toBe("plugin_initialization_failed")
  })

  it("keeps the raw error collapsed behind a calm inline status", () => {
    act(() => root.render(createElement(RunErrorNotice, { error: "413 status code (no body)" })))

    const status = container.querySelector("[data-run-error-notice]")
    const details = status?.querySelector("details")
    const summary = details?.querySelector("summary")

    expect(summary?.textContent).toContain("请求内容过大，请减少附件或上下文后再试。")
    expect(summary?.textContent).not.toContain("这次请求没有完成")
    expect(details?.open).toBe(false)
    expect(summary?.textContent).toContain("详情")
    expect(details?.querySelector("pre")?.textContent).toBe("413 status code (no body)")
    expect(status?.className).not.toContain("border")
    expect(status?.className).not.toContain("bg-destructive")
    expect(summary?.getAttribute("aria-live")).toBe("polite")
    expect(summary?.querySelector("svg")?.className.baseVal).toContain("text-amber")
    expect(summary?.querySelector("div, p")).toBeNull()
    const detailControl = summary?.querySelector("[data-run-error-detail-control]")
    expect(detailControl?.textContent).toContain("详情")
    expect(detailControl?.querySelector("svg")).not.toBeNull()
    expect(detailControl?.className).toContain("whitespace-nowrap")
  })

  it("shows model mismatch guidance without exposing the raw error by default", () => {
    const error = "This model is not supported when using Codex"
    act(() => root.render(createElement(RunErrorNotice, { error })))

    const status = container.querySelector("[data-run-error-notice]")
    expect(status?.textContent).toContain("当前模型与供应商不匹配")
    expect(status?.textContent).not.toContain("这次请求没有完成")
    expect(status?.querySelector("details")?.open).toBe(false)
    expect(status?.querySelector("pre")?.textContent).toBe(error)
  })

  it.each([
    ["400 Bad Request", "请求参数错误，请检查输入内容或附件后再试。"],
    ["401 Unauthorized", "身份验证未通过，请检查登录状态或 API 密钥。"],
    ["HTTP 402 Payment Required", "账户余额或订阅状态异常，请检查账单设置。"],
    ["HTTP 403 Forbidden", "当前账号无权使用该模型或服务，请检查权限配置。"],
    ["404 Not Found", "未找到对应的模型或服务接口，请检查模型与服务地址。"],
    ["request status 408", "请求等待时间过长，请稍后再试。"],
    ["HTTPError: 409 Conflict", "请求状态发生冲突，请稍后再试。"],
    ["413 status code (no body)", "请求内容过大，请减少附件或上下文后再试。"],
    ["response code 422", "服务无法处理当前参数，请检查输入或模型配置。"],
    ['request failed with "status": 429', "请求过于频繁或额度受限，请稍后再试。"],
    ["HTTP/1.1 500 Internal Server Error", "服务暂时不可用，请稍后再试。"],
    ["HTTP status code: 503", "服务暂时不可用，请稍后再试。"],
    ["HTTPError: 503 Service Unavailable", "服务暂时不可用，请稍后再试。"],
    ["response code 429", "请求过于频繁或额度受限，请稍后再试。"],
    ["HTTP 599 provider error", "服务返回异常，请展开详情了解原因。"],
    ["501 Not Implemented", "当前服务不支持这项请求，请检查模型或服务配置。"],
    ["507 Insufficient Storage", "服务返回异常，请展开详情了解原因。"],
    ["511 Network Authentication Required", "网络访问需要额外身份验证，请检查网络或代理设置。"],
  ])("shows friendly guidance for %s", (error, guidance) => {
    act(() => root.render(createElement(RunErrorNotice, { error })))

    expect(container.querySelector("[data-run-error-notice]")?.textContent).toContain(guidance)
    expect(container.querySelector("summary")?.textContent).not.toContain("这次请求没有完成")
    expect(container.querySelector("details")?.open).toBe(false)
    expect(container.querySelector("pre")?.textContent).toBe(error)
  })

  it("uses one fallback line when an error has no known guidance", () => {
    act(() => root.render(createElement(RunErrorNotice, { error: "unexpected provider failure" })))

    const summary = container.querySelector("summary")
    expect(summary?.textContent).toContain("这次请求没有完成")
    expect(summary?.textContent).toContain("详情")
    expect(summary?.querySelector(".block")).toBeNull()
  })

  it.each([
    "500 source files failed validation",
    "process exited with status code 503",
    "job status: 409",
  ])("does not interpret non-HTTP text as a status: %s", (error) => {
    act(() => root.render(createElement(RunErrorNotice, { error })))

    expect(container.textContent).not.toContain("服务暂时不可用")
    expect(container.textContent).not.toContain("请求状态发生冲突")
  })

  it("keeps model mismatch guidance ahead of an HTTP status", () => {
    act(() =>
      root.render(
        createElement(RunErrorNotice, {
          error: "HTTP 403: model is not supported when using Codex",
        })
      )
    )

    expect(container.textContent).toContain("当前模型与供应商不匹配")
    expect(container.textContent).not.toContain("请检查权限配置")
  })

  it("does not render an empty details control when no error was returned", () => {
    act(() => root.render(createElement(RunErrorNotice, {})))

    expect(container.textContent).toContain("这次请求没有完成，暂时没有更多错误信息。")
    expect(container.querySelector("details")).toBeNull()
    expect(container.querySelector("summary")).toBeNull()
    expect(container.querySelector("[data-run-error-status-row]")?.getAttribute("aria-live")).toBe(
      "polite"
    )
  })
})
