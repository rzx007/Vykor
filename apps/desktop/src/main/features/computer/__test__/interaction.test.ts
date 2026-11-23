import type { WebContents } from "electron"
import { beforeEach, expect, it, vi } from "vitest"

const preferences = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}))
const overlay = vi.hoisted(() => ({ show: vi.fn(), close: vi.fn() }))
vi.mock("../computer-control-overlay", () => ({ showComputerControlOverlay: overlay.show }))
vi.mock("../../settings/desktop-preferences", () => ({
  getDesktopPreferences: preferences.get,
  patchDesktopPreferences: preferences.patch,
}))

import { createComputerInteraction, replyToComputerInteraction } from "../interaction"

const app = { id: "notepad-publisher-id", name: "记事本" }
function window() {
  const send = vi.fn()
  return { owner: { send, isDestroyed: () => false } as unknown as WebContents, send }
}

beforeEach(() => {
  preferences.get.mockReturnValue({ computerAppGrants: [] })
  preferences.patch.mockClear()
  overlay.show.mockReset().mockReturnValue(overlay.close)
  overlay.close.mockClear()
})

it("shows the overlay only while input is held and forwards an emergency stop once", () => {
  const { owner } = window()
  const scope = new AbortController()
  const stop = vi.fn()
  const interaction = createComputerInteraction(owner, scope.signal, id => id === "session", stop)
  interaction.publishActivity("other", { runId: "run", phase: "foreground" })
  interaction.publishActivity("session", { runId: "run", phase: "observing" })
  expect(overlay.show).not.toHaveBeenCalled()
  interaction.publishActivity("session", { runId: "run", phase: "foreground" })
  interaction.publishActivity("session", { runId: "run", phase: "foreground" })
  expect(overlay.show).toHaveBeenCalledOnce()
  interaction.publishActivity("session", { runId: "run", phase: "stopped" })
  expect(overlay.close).toHaveBeenCalledOnce()
  interaction.emergencyStop("session", "run")
  expect(stop).toHaveBeenCalledExactlyOnceWith("session", "run")
  interaction.emergencyStop("session", "run")
  scope.abort()
  expect(stop).toHaveBeenCalledTimes(1)
})

it("requires task approval for automatic Computer calls even with a saved app grant", async () => {
  preferences.get.mockReturnValue({ computerAppGrants: [app] })
  const { owner, send } = window()
  const signal = new AbortController().signal
  const interaction = createComputerInteraction(owner, signal)
  expect(await interaction.authorizeApp(app, signal, "session")).toBe("remembered")
  const approval = interaction.authorizeApp(app, signal, "session", true)
  const { prompt } = send.mock.lastCall?.[1]
  expect(prompt).toMatchObject({ kind: "authorize", appName: app.name, onceOnly: true })
  expect(replyToComputerInteraction(owner, { id: prompt.id, choice: "always" })).toBe(false)
  expect(replyToComputerInteraction(owner, { id: prompt.id, choice: "once" })).toBe(true)
  await expect(approval).resolves.toBe(true)
  expect(preferences.patch).not.toHaveBeenCalled()
})

it("keeps window pixels available only in the current initiating chat and clears them on invalidation", () => {
  const { owner, send } = window()
  const lifetime = new AbortController()
  let active = "current"
  const interaction = createComputerInteraction(owner, lifetime.signal, id => id === active)
  const preview = { dataUrl: "data:image/png;base64,YQ==", width: 1, height: 1 }
  interaction.publishActivity("current", { runId: "run", phase: "ready", preview })
  expect(interaction.getActivity("current")?.preview).toEqual(preview)
  expect(send.mock.lastCall?.[1]).toMatchObject({ sessionId: "current", activity: { runId: "run", preview } })
  interaction.publishActivity("current", { runId: "old", phase: "stopped" })
  expect(interaction.getActivity("current")?.runId).toBe("run")
  active = "other"
  expect(interaction.getActivity("current")).toBeNull()
  interaction.clearPreview()
  expect(send.mock.calls).toHaveLength(1)
  active = "current"
  expect(interaction.getActivity("current")).toMatchObject({ runId: "run", phase: "ready" })
  expect(interaction.getActivity("current")?.preview).toBeUndefined()
  lifetime.abort()
  expect(interaction.getActivity("current")).toBeNull()
})

it("allows an app only from its owner's current prompt and stores a grant only for always", async () => {
  const { owner, send } = window()
  const controller = new AbortController()
  const interaction = createComputerInteraction(owner, controller.signal)
  const first = interaction.authorizeApp(app, controller.signal, "session")
  const request = send.mock.lastCall?.[1]
  expect(request).toMatchObject({ type: "prompt", prompt: { kind: "authorize", appName: app.name } })
  expect(replyToComputerInteraction(window().owner, { id: request.prompt.id, choice: "always" })).toBe(false)
  expect(replyToComputerInteraction(owner, { id: request.prompt.id, choice: "once" })).toBe(true)
  expect(await first).toBe(true)
  expect(preferences.patch).not.toHaveBeenCalled()
  const second = interaction.authorizeApp(app, controller.signal, "session")
  expect(replyToComputerInteraction(owner, { id: request.prompt.id, choice: "always" })).toBe(false)
  const current = send.mock.lastCall?.[1].prompt.id
  expect(replyToComputerInteraction(owner, { id: current, choice: "always" })).toBe(true)
  expect(await second).toBe("remembered")
  expect(preferences.patch).toHaveBeenCalledExactlyOnceWith({ computerAppGrants: [app] })
})

it("passes only displayed choices and dismisses a cancelled selection", async () => {
  const { owner, send } = window()
  const controller = new AbortController()
  const candidates = [{ id: "a", label: "文档" }, { id: "b", label: "文档" }]
  const interaction = createComputerInteraction(owner, controller.signal)
  await expect(interaction.chooseTarget([candidates[0]!], controller.signal)).resolves.toBe("a")
  expect(send).not.toHaveBeenCalled()
  const first = interaction.chooseTarget(candidates, controller.signal)
  const firstId = send.mock.lastCall?.[1].prompt.id
  expect(replyToComputerInteraction(owner, { id: firstId, choice: "b" })).toBe(true)
  expect(await first).toBe("b")
  const result = interaction.chooseTarget(candidates, controller.signal)
  const id = send.mock.lastCall?.[1].prompt.id
  expect(replyToComputerInteraction(owner, { id, choice: "other" })).toBe(false)
  controller.abort()
  expect(await result).toBeUndefined()
  expect(send.mock.lastCall?.[1]).toMatchObject({ type: "dismissed", id })
  expect(replyToComputerInteraction(owner, { id, choice: "a" })).toBe(false)
})

it("dismisses a reply from another chat and waits for the active chat before asking again", async () => {
  const { owner, send } = window()
  const signal = new AbortController().signal
  let active: string | undefined = "original"
  const interaction = createComputerInteraction(owner, signal, id => id === active)
  const permission = interaction.authorizeApp(app, signal, "original")
  const permissionId = send.mock.lastCall?.[1].prompt.id
  active = "other"
  expect(replyToComputerInteraction(owner, { id: permissionId, choice: "always" })).toBe(false)
  expect(await permission).toBe(false)
  expect(send.mock.lastCall?.[1]).toMatchObject({ type: "dismissed", id: permissionId })
  expect(preferences.patch).not.toHaveBeenCalled()

  active = undefined
  const candidates = [{ id: "a", label: "文档" }, { id: "b", label: "文档" }]
  await expect(interaction.chooseTarget(candidates, signal, "original")).resolves.toBeUndefined()
  expect(send.mock.lastCall?.[1]).toMatchObject({ type: "dismissed", id: permissionId })
  active = "original"
  const selection = interaction.chooseTarget(candidates, signal, "original")
  const selectionId = send.mock.lastCall?.[1].prompt.id
  expect(replyToComputerInteraction(owner, { id: selectionId, choice: "b" })).toBe(true)
  expect(await selection).toBe("b")
})
