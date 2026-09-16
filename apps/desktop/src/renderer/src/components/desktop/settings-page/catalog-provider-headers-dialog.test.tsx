// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopProviderInfo } from "@shared/provider-types"
import { CatalogProviderHeadersDialog } from "./catalog-provider-headers-dialog"

describe("CatalogProviderHeadersDialog", () => {
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

  it("echoes saved templates without an API key field", async () => {
    await act(async () => {
      root.render(
        createElement(CatalogProviderHeadersDialog, {
          provider: connectedCatalogProvider,
          busy: false,
          onOpenChange: vi.fn(),
          onSubmit: vi.fn(),
        })
      )
    })

    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 名称"]')?.value
    ).toBe("X-Session")
    expect(document.querySelector<HTMLInputElement>('input[aria-label="请求头 1 值"]')?.value).toBe(
      "{{sessionId}}"
    )
    expect(document.body.textContent).toContain("{{sessionId}}")
    expect(document.body.textContent).toContain("{{userAgent}}")
    expect(document.querySelector("#provider-api-key")).toBeNull()
    expect(document.querySelector("#custom-provider-key")).toBeNull()
    expect(document.body.textContent).not.toContain("API 密钥")
  })

  it("submits an empty object after every row is removed", async () => {
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        createElement(CatalogProviderHeadersDialog, {
          provider: connectedCatalogProvider,
          busy: false,
          onOpenChange: vi.fn(),
          onSubmit,
        })
      )
    })

    await act(async () => {
      findButton("删除请求头 1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it("disables save and close while busy", async () => {
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(
        createElement(CatalogProviderHeadersDialog, {
          provider: connectedCatalogProvider,
          busy: true,
          onOpenChange,
          onSubmit: vi.fn(),
        })
      )
    })

    const saveButton = findButton("保存")
    const cancelButton = findButton("取消")
    expect(saveButton?.disabled).toBe(true)
    expect(cancelButton?.disabled).toBe(true)

    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

const connectedCatalogProvider: DesktopProviderInfo = {
  name: "remote",
  displayName: "Remote Catalog",
  connected: true,
  active: false,
  local: false,
  credentialSource: "credentials",
  credentialLabel: "OpenHarness 密钥",
  models: [{ id: "model-a", label: "Model A" }],
  source: "catalog",
  headers: { "X-Session": "{{sessionId}}" },
}

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.textContent?.includes(label) || button.getAttribute("aria-label")?.includes(label)
    ) ?? null
  )
}
