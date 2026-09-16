// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopProviderInfo } from "@shared/provider-types"
import { ProviderConnectionDialog } from "./provider-connection-dialog"

describe("ProviderConnectionDialog", () => {
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

  it("shows collapsed advanced options only for catalog providers", async () => {
    await renderDialog({ provider: catalogProvider })

    expect(document.body.textContent).toContain("高级选项")
    expect(document.body.textContent).not.toContain("{{sessionId}}")

    await act(async () => {
      findButton("高级选项")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(document.body.textContent).toContain("{{sessionId}}")
    expect(document.body.textContent).toContain("{{userAgent}}")
    expect(document.body.textContent).toContain("明文保存在 settings.json")
  })

  it("submits headers with the api key for catalog providers", async () => {
    const onSubmit = vi.fn()
    await renderDialog({ provider: catalogProvider, onSubmit })

    await act(async () => {
      findButton("高级选项")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await act(async () => {
      findButton("添加请求头")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 名称"]')
    const valueInput = document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 值"]')
    const apiKeyInput = document.querySelector<HTMLInputElement>("#provider-api-key")
    expect(nameInput).not.toBeNull()
    expect(valueInput).not.toBeNull()
    expect(apiKeyInput).not.toBeNull()

    await act(async () => {
      setInputValue(apiKeyInput!, "sk-test")
      setInputValue(nameInput!, "X-Session")
      setInputValue(valueInput!, "{{sessionId}}")
    })

    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: "sk-test",
      headers: { "X-Session": "{{sessionId}}" },
      setActive: true,
    })
  })

  it("uses headersDirty three-state semantics for catalog reconnect", async () => {
    const onSubmit = vi.fn()
    await renderDialog({
      provider: {
        ...catalogProvider,
        headers: { "X-Session": "{{sessionId}}" },
        connected: false,
        credentialSource: "none",
      },
      onSubmit,
    })

    const apiKeyInput = document.querySelector<HTMLInputElement>("#provider-api-key")
    await act(async () => {
      setInputValue(apiKeyInput!, "sk-reconnect")
    })
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: "sk-reconnect",
      setActive: true,
    })
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("headers")

    onSubmit.mockClear()
    await act(async () => {
      findButton("高级选项")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 名称"]')
    await act(async () => {
      setInputValue(nameInput!, "X-Tenant")
      setInputValue(
        document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 值"]')!,
        "desktop"
      )
    })
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: "sk-reconnect",
      headers: { "X-Tenant": "desktop" },
      setActive: true,
    })

    onSubmit.mockClear()
    await act(async () => {
      findButton("删除请求头 1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: "sk-reconnect",
      headers: {},
      setActive: true,
    })
  })

  it("omits advanced options and headers for builtin providers", async () => {
    const onSubmit = vi.fn()
    await renderDialog({ provider: builtinProvider, onSubmit })

    expect(document.body.textContent).not.toContain("高级选项")
    const apiKeyInput = document.querySelector<HTMLInputElement>("#provider-api-key")
    await act(async () => {
      setInputValue(apiKeyInput!, "sk-builtin")
    })
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: "sk-builtin",
      setActive: true,
    })
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("headers")
  })

  it("resets header rows when reopening another provider", async () => {
    const onOpenChange = vi.fn()
    await renderDialog({
      provider: {
        ...catalogProvider,
        headers: { "X-Old": "one" },
      },
      onOpenChange,
    })

    await act(async () => {
      findButton("高级选项")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 名称"]')?.value
    ).toBe("X-Old")

    await act(async () => {
      root.render(
        createElement(ProviderConnectionDialog, {
          open: false,
          provider: catalogProvider,
          busy: false,
          onOpenChange,
          onSubmit: vi.fn(),
        })
      )
    })
    await act(async () => {
      root.render(
        createElement(ProviderConnectionDialog, {
          open: true,
          provider: {
            ...catalogProvider,
            name: "other-catalog",
            displayName: "Other Catalog",
            headers: { "X-New": "{{userAgent}}" },
          },
          busy: false,
          onOpenChange,
          onSubmit: vi.fn(),
        })
      )
    })

    await act(async () => {
      findButton("高级选项")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 名称"]')?.value
    ).toBe("X-New")
    expect(document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 值"]')?.value).toBe(
      "{{userAgent}}"
    )
  })

  async function renderDialog({
    provider,
    onSubmit = vi.fn(),
    onOpenChange = vi.fn(),
  }: {
    provider: DesktopProviderInfo
    onSubmit?: ReturnType<typeof vi.fn>
    onOpenChange?: ReturnType<typeof vi.fn>
  }): Promise<void> {
    await act(async () => {
      root.render(
        createElement(ProviderConnectionDialog, {
          open: true,
          provider,
          busy: false,
          onOpenChange,
          onSubmit,
        })
      )
    })
  }
})

const catalogProvider: DesktopProviderInfo = {
  name: "remote",
  displayName: "Remote Catalog",
  connected: false,
  active: false,
  local: false,
  credentialSource: "none",
  models: [{ id: "model-a", label: "Model A" }],
  source: "catalog",
}

const builtinProvider: DesktopProviderInfo = {
  name: "openai",
  displayName: "OpenAI",
  connected: false,
  active: false,
  local: false,
  credentialSource: "none",
  models: [{ id: "gpt-4o", label: "GPT-4o" }],
  source: "builtin",
}

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.textContent?.includes(label) || button.getAttribute("aria-label")?.includes(label)
    ) ?? null
  )
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
