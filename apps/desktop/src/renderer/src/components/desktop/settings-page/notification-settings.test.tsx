// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { NotificationSettingsSnapshot } from "@shared/notification-settings-types"
import { buildDesktopSettingsSnapshot } from "@shared/settings-types"
import { NotificationSettings } from "./notification-settings"

let container: HTMLDivElement, root: Root, saved: NotificationSettingsSnapshot
const updateMode = vi.fn(async (input: { mode: NotificationSettingsSnapshot["mode"] }) => {
  saved = { ...saved, mode: input.mode }
  return saved
})
const updateEvents = vi.fn()
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  saved = {
    mode: "never",
    events: { completed: false, failed: true, needs_input: true },
    system: {
      supported: true,
      permission: "unknown",
      settingsAvailable: false,
      detail: "状态未知",
    },
  }
  updateMode.mockClear()
  updateEvents.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      notificationSettings: { snapshot: async () => saved, updateMode, updateEvents },
      settings: { snapshot: async () => buildDesktopSettingsSnapshot({}) },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it("hides disabled notification events without hiding independent sounds or resetting event choices", async () => {
  await act(async () => root.render(<NotificationSettings />))
  expect(container.querySelector('[aria-label="任务完成系统通知"]')).toBeNull()
  expect(container.querySelector('[aria-label="智能体音效"]')).not.toBeNull()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="系统通知模式"]')!.click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === "始终")!
      .click()
  )
  expect(
    container.querySelector('[aria-label="任务完成系统通知"]')!.getAttribute("aria-checked")
  ).toBe("false")
  expect(
    container.querySelector('[aria-label="任务失败系统通知"]')!.getAttribute("aria-checked")
  ).toBe("true")
  expect(updateEvents).not.toHaveBeenCalled()
})
