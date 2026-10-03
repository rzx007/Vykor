// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { buildDesktopSettingsSnapshot } from "@shared/settings-types"
import type { UpdateDesktopNotificationSoundsInput } from "@shared/settings-types"
import { NotificationSoundSettings } from "./notification-sound-settings"

let container: HTMLDivElement
let root: Root
const snapshot = buildDesktopSettingsSnapshot(
  {},
  {
    notificationSounds: { completed: "staplebops-01", needs_input: "none", failed: "nope-03" },
  }
)
const readSnapshot = vi.fn(async () => snapshot)
const update = vi.fn(async ({ notificationSounds }: UpdateDesktopNotificationSoundsInput) => ({
  ...snapshot,
  notificationSounds,
}))

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { settings: { snapshot: readSnapshot, updateNotificationSounds: update } },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it("saves and previews a selected sound without resetting other choices", async () => {
  const play = vi.fn(async () => undefined)
  const audio = vi.fn(function () {
    return { play, pause: vi.fn() }
  })
  vi.stubGlobal("Audio", audio)
  await act(async () => root.render(<NotificationSoundSettings />))
  expect(container.querySelector('[aria-label="权限音效"]')?.textContent).toContain("无声音")
  await choose("智能体音效", "Bip-bop 08")
  expect(update).toHaveBeenCalledWith({
    notificationSounds: { completed: "bip-bop-08", needs_input: "none", failed: "nope-03" },
  })
  expect(container.querySelector('[aria-label="智能体音效"]')?.textContent).toContain("Bip-bop 08")
  expect(audio).toHaveBeenCalledWith(expect.stringContaining("bip-bop-08"))
  expect(play).toHaveBeenCalledOnce()
})

it("selects no sound without playing audio", async () => {
  const play = vi.fn(async () => undefined)
  const audio = vi.fn(function () {
    return { play, pause: vi.fn() }
  })
  vi.stubGlobal("Audio", audio)
  await act(async () => root.render(<NotificationSoundSettings />))
  await choose("智能体音效", "无声音")
  expect(play).not.toHaveBeenCalled()
  expect(update).toHaveBeenCalledWith({
    notificationSounds: { completed: "none", needs_input: "none", failed: "nope-03" },
  })
})

it.each([
  {
    name: "missing sound settings",
    value: undefined,
    expected: ["Staplebops 01", "Staplebops 02", "Nope 03"],
  },
  {
    name: "null sound settings",
    value: null,
    expected: ["Staplebops 01", "Staplebops 02", "Nope 03"],
  },
  {
    name: "partial sound settings",
    value: { completed: false },
    expected: ["无声音", "Staplebops 02", "Nope 03"],
  },
])("renders safely when the snapshot contains $name", async ({ value, expected }) => {
  readSnapshot.mockResolvedValueOnce({
    ...snapshot,
    notificationSounds: value,
  } as unknown as typeof snapshot)
  await act(async () => root.render(<NotificationSoundSettings />))
  expect(
    Array.from(container.querySelectorAll('[role="combobox"]'), (select) =>
      select.querySelector('[data-slot="select-value"]')?.textContent?.trim()
    )
  ).toEqual(expected)
})

it("keeps the submitted selection when a save response omits the sound settings", async () => {
  update.mockResolvedValueOnce({
    ...snapshot,
    notificationSounds: undefined,
  } as unknown as typeof snapshot)
  await act(async () => root.render(<NotificationSoundSettings />))
  await choose("智能体音效", "无声音")
  expect(
    Array.from(container.querySelectorAll('[role="combobox"]'), (select) =>
      select.querySelector('[data-slot="select-value"]')?.textContent?.trim()
    )
  ).toEqual(["无声音", "无声音", "Nope 03"])
})

async function choose(label: string, text: string): Promise<void> {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
  )
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (node) => node.textContent?.trim() === text
  )
  expect(option).toBeDefined()
  await act(async () => {
    option!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    option!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    option!.click()
  })
}
