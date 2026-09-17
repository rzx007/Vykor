// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopProviderInfo } from "@shared/provider-types"
import { CustomProviderDialog } from "./custom-provider-dialog"

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
    expect(document.body.textContent).toContain("密钥已保存在本机")
    const replaceButton = findButton("更换")
    expect(replaceButton).not.toBeNull()

    await act(async () => {
      findButton("保存修改")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() }),
      false
    )

    await act(async () => {
      replaceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(input?.value).toBe("")
    expect(input?.readOnly).toBe(false)
    expect(document.body.textContent).toContain("输入新的 API 密钥")
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

    expect(document.body.textContent).toContain("{{sessionId}}")
    expect(document.body.textContent).toContain("{{userAgent}}")
    expect(document.body.textContent).toContain("明文保存在 settings.json")
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
})

const savedCustomProvider: DesktopProviderInfo = {
  name: "office-gateway",
  displayName: "Office Gateway",
  connected: true,
  active: false,
  local: false,
  credentialSource: "credentials",
  credentialLabel: "OpenHarness 密钥",
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
