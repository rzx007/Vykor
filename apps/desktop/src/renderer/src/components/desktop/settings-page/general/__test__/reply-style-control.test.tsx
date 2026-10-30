// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReplyStyle } from "@vykor/application-client"
import { buildDesktopSettingsSnapshot, type DesktopSettingsSnapshot } from "@shared/settings-types"
import { ReplyStyleControl, WorkStyleControl } from "../general-display-controls"

describe("ReplyStyleControl", () => {
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

  it("keeps the control disabled until the saved style is loaded", async () => {
    const loading = deferred<DesktopSettingsSnapshot>()
    installSettings({ snapshot: () => loading.promise })
    await act(async () => root.render(<ReplyStyleControl />))

    expect(trigger().disabled).toBe(true)
    await act(async () =>
      loading.resolve(buildDesktopSettingsSnapshot({ replyStyle: "explanatory" }))
    )

    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toContain("讲解")
  })

  it.each([
    ["direct", "直接"],
    ["explanatory", "讲解"],
  ] as const)("saves %s and disables duplicate changes while saving", async (style, label) => {
    const saving = deferred<DesktopSettingsSnapshot>()
    let saved: ReplyStyle = "collaborative"
    installSettings({
      snapshot: async () => buildDesktopSettingsSnapshot({ replyStyle: saved }),
      updateReplyStyle: async ({ replyStyle }) => {
        saved = replyStyle
        return saving.promise
      },
    })
    await act(async () => root.render(<ReplyStyleControl />))
    await choose(label)

    expect(saved).toBe(style)
    expect(trigger().disabled).toBe(true)
    expect(trigger().textContent).toContain(label)
    await act(async () => saving.resolve(buildDesktopSettingsSnapshot({ replyStyle: style })))

    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toContain(label)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("restores the saved style and shows the error when saving fails", async () => {
    installSettings({
      snapshot: async () => buildDesktopSettingsSnapshot({ replyStyle: "direct" }),
      updateReplyStyle: async () => {
        throw new Error("无法保存设置")
      },
    })
    await act(async () => root.render(<ReplyStyleControl />))
    await choose("讲解")

    expect(trigger().textContent).toContain("直接")
    expect(trigger().disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法保存设置")
  })

  it("shows a load error without leaving the control in a loading state", async () => {
    installSettings({
      snapshot: async () => {
        throw new Error("无法读取设置")
      },
    })
    await act(async () => root.render(<ReplyStyleControl />))

    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toContain("协作")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法读取设置")
  })

  it("uses the progress notification name while retaining the existing saved value", async () => {
    let workStyle = "practical"
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        settings: {
          snapshot: async () => buildDesktopSettingsSnapshot({ workStyle }),
          updateWorkStyle: async (input: { workStyle: string }) => {
            workStyle = input.workStyle
            return buildDesktopSettingsSnapshot({ workStyle })
          },
        },
      },
    })
    await act(async () => root.render(<WorkStyleControl />))
    const progress = container.querySelector<HTMLButtonElement>('[aria-label="进度通知"]')!
    expect(progress.textContent).toContain("关键节点")
    await act(async () => progress.click())
    await clickOption("必要时")

    expect(workStyle).toBe("efficient")
    expect(progress.textContent).toContain("必要时")
  })

  function trigger(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>('[aria-label="回复风格"]')!
  }

  async function choose(label: string) {
    await act(async () => trigger().click())
    await clickOption(label)
  }
})

async function clickOption(label: string) {
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === label
  )
  expect(option, `${label} option`).toBeDefined()
  await act(async () => {
    option!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    option!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    option!.click()
  })
}

function installSettings(settings: {
  snapshot: () => Promise<DesktopSettingsSnapshot>
  updateReplyStyle?: (input: { replyStyle: ReplyStyle }) => Promise<DesktopSettingsSnapshot>
}) {
  Object.defineProperty(window, "desktop", { configurable: true, value: { settings } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
