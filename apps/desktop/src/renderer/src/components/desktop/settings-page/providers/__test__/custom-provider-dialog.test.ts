// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopProviderInfo } from "@shared/provider-types"
import { CustomProviderDialog } from "../custom-provider-dialog"

describe("CustomProviderDialog credentials", () => {
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
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("shows a saved credential as masked until the user chooses to replace it", async () => {
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        createElement(CustomProviderDialog, {
          open: true,
          provider: savedCustomProvider,
          busy: false,
          onOpenChange: vi.fn(),
          onSubmit,
        })
      )
    })

    const input = document.querySelector<HTMLInputElement>("#custom-provider-key")
    expect(input?.value).toBe("••••••••••••")
    expect(input?.readOnly).toBe(true)
    expect(document.body.textContent).not.toContain("可能产生费用")
    const replaceButton = findButton("更换")
    expect(replaceButton).not.toBeNull()

    await act(async () => {
      findButton("保存修改")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() })
    )

    await act(async () => {
      replaceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(input?.value).toBe("")
    expect(input?.readOnly).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(document.body.textContent).not.toContain("可能产生费用")
    await act(async () => setInputValue(input!, "sk-new"))
    expect(document.body.textContent).toContain("可能产生费用")
  })

  it("shows template guidance and echoes saved header templates", async () => {
    await act(async () => {
      root.render(
        createElement(CustomProviderDialog, {
          open: true,
          provider: {
            ...savedCustomProvider,
            headers: {
              "X-Session": "{{sessionId}}",
              "User-Agent": "{{userAgent}}",
            },
          },
          busy: false,
          onOpenChange: vi.fn(),
          onSubmit: vi.fn(),
        })
      )
    })

    const help = document.querySelector<HTMLButtonElement>('[aria-label="请求头说明"]')!
    expect(help.tabIndex).toBe(0)
    await act(async () => help.focus())
    expect(document.activeElement).toBe(help)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("{{sessionId}}")
    expect(document.querySelector('[aria-label="请求头 1 机密值"]')).not.toBeNull()
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 名称"]')?.value
    ).toBe("X-Session")
    expect(document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 值"]')?.value).toBe(
      "{{sessionId}}"
    )
    expect(document.querySelector<HTMLInputElement>('input[aria-label="请求头 2 值"]')?.value).toBe(
      "{{userAgent}}"
    )

    const input = document.querySelector<HTMLInputElement>("#custom-provider-key")
    expect(input?.value).toBe("••••••••••••")
  })

  it("keeps old model parameters and headers when appending rows and saving", async () => {
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        createElement(CustomProviderDialog, {
          open: true,
          provider: {
            ...savedCustomProvider,
            models: [
              { id: "default", label: "Default", contextWindow: 64000 },
              {
                id: "custom",
                label: "Custom",
                imageInputSupport: "native",
                declaredLimits: { contextWindow: 123456, maxOutputTokens: 7654 },
              },
            ],
            headers: { "X-Tenant": "desktop", "X-Session": "{{sessionId}}" },
            secretHeaderNames: ["X-Token"],
          },
          busy: false,
          onOpenChange: vi.fn(),
          onSubmit,
        })
      )
    })
    const params = [
      ...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
    ].filter((button) => button.textContent?.includes("模型参数"))
    expect(params.map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "true"])
    await act(async () => params[0]!.click())
    expect(params[0]?.getAttribute("aria-expanded")).toBe("true")

    await act(async () => findButton("添加模型")?.click())
    await act(async () => findButton("添加模型")?.click())
    await act(async () => findButton("添加请求头")?.click())
    await act(async () => findButton("添加请求头")?.click())
    await act(async () => {
      setInputValue(findInput("模型 3 ID"), "third")
      setInputValue(findInput("模型 4 ID"), "fourth")
      setInputValue(findInput("请求头 4 名称"), "X-Extra")
      setInputValue(findInput("请求头 4 值"), "extra")
      setInputValue(findInput("请求头 5 名称"), "X-Agent")
      setInputValue(findInput("请求头 5 值"), "{{userAgent}}")
    })
    await act(async () => findButton("保存修改")?.click())
    expect(onSubmit).toHaveBeenCalledWith({
      id: "office-gateway",
      displayName: "Office Gateway",
      baseUrl: "https://gateway.example/v1",
      apiFormat: "openai",
      models: [
        { id: "default", displayName: "Default", imageInputSupport: "unknown" },
        {
          id: "custom",
          displayName: "Custom",
          imageInputSupport: "native",
          contextWindow: 123456,
          maxOutputTokens: 7654,
        },
        { id: "third", displayName: "third", imageInputSupport: "unknown" },
        { id: "fourth", displayName: "fourth", imageInputSupport: "unknown" },
      ],
      headers: {
        "X-Tenant": "desktop",
        "X-Session": "{{sessionId}}",
        "X-Extra": "extra",
        "X-Agent": "{{userAgent}}",
      },
    })
  })

  it("focuses the invalid field and submits a complete new provider", async () => {
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        createElement(CustomProviderDialog, {
          open: true,
          busy: false,
          onOpenChange: vi.fn(),
          onSubmit,
        })
      )
    })
    const displayName = document.querySelector<HTMLInputElement>("#custom-provider-name")!
    const id = document.querySelector<HTMLInputElement>("#custom-provider-id")!
    const baseUrl = document.querySelector<HTMLInputElement>("#custom-provider-url")!
    const submit = () => act(async () => document.querySelector("form")?.requestSubmit())
    await submit()
    expect(document.activeElement).toBe(displayName)
    expect(
      document.getElementById(displayName.getAttribute("aria-describedby")!)?.textContent
    ).toBe("请输入显示名称。")

    await act(async () => {
      setInputValue(displayName, "Gateway")
      setInputValue(id, "gateway")
      setInputValue(baseUrl, "https://example.test/v1")
      setInputValue(findInput("模型 1 ID"), "local-model")
      findButton("添加请求头")?.click()
    })
    await act(async () => setInputValue(findInput("请求头 1 名称"), "X-Session"))
    await submit()
    const headerValue = findInput("请求头 1 值")
    expect(document.activeElement).toBe(headerValue)
    expect(headerValue.getAttribute("aria-invalid")).toBe("true")
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => setInputValue(headerValue, "{{sessionId}}"))
    await submit()
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gateway",
        models: [{ id: "local-model", displayName: "local-model", imageInputSupport: "unknown" }],
        headers: { "X-Session": "{{sessionId}}" },
      })
    )
  })
})

const savedCustomProvider: DesktopProviderInfo = {
  name: "office-gateway",
  displayName: "Office Gateway",
  connected: true,
  active: false,
  local: false,
  credentialSource: "credentials",
  credentialLabel: "Vykor 密钥",
  models: [{ id: "team-model", label: "Team Model", imageInputSupport: "unknown" }],
  custom: true,
  baseUrl: "https://gateway.example/v1",
  apiFormat: "openai",
}

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label
    ) ?? null
  )
}

function findInput(label: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
