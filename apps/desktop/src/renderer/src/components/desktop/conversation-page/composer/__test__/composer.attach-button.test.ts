// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Composer } from "../composer"
import { emptyComposerDocument } from "@renderer/stores/desktop-session/composer-document"

describe("Composer attach button", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  })

  it("opens the context picker and then reuses the file picker", async () => {
    const onPickFiles = vi.fn()

    await act(async () => {
      root.render(
        createElement(Composer, {
          id: "composer-attach-test",
          draft: emptyComposerDocument,
          sending: false,
          models: [],
          selectedModel: null,
          selectedProvider: null,
          modelLabel: "模型",
          permissionMode: "default",
          effort: null,
          onDraftChange: vi.fn(),
          onSubmit: vi.fn(),
          onSelectModel: vi.fn(),
          onSelectPermissionMode: vi.fn(),
          onSelectEffort: vi.fn(),
          attachmentInteractionEnabled: true,
          onPickFiles,
        })
      )
    })

    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === "添加上下文"
    )
    expect(button).not.toBeNull()
    expect(button?.disabled).toBe(false)

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(onPickFiles).not.toHaveBeenCalled()
    expect(container.querySelector('[role="listbox"][aria-label="添加上下文"]')).not.toBeNull()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(container.querySelector('[role="listbox"][aria-label="添加上下文"]')).toBeNull()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    const files = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.includes("文件和文件夹")
    )
    await act(async () => files?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(onPickFiles).toHaveBeenCalledOnce()
  })

  it("keeps the context button enabled when attachment interaction is off", async () => {
    await act(async () => {
      root.render(
        createElement(Composer, {
          id: "composer-attach-disabled",
          draft: emptyComposerDocument,
          sending: false,
          models: [],
          selectedModel: null,
          selectedProvider: null,
          modelLabel: "模型",
          permissionMode: "default",
          effort: null,
          onDraftChange: vi.fn(),
          onSubmit: vi.fn(),
          onSelectModel: vi.fn(),
          onSelectPermissionMode: vi.fn(),
          onSelectEffort: vi.fn(),
          attachmentInteractionEnabled: false,
          onPickFiles: vi.fn(),
        })
      )
    })

    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === "添加上下文"
    )
    expect(button?.disabled).toBe(false)
  })
})
