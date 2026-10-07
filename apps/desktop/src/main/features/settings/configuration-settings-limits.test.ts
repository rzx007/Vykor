import { beforeEach, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({
  settings: { maxTurns: 50, maxTurnsEditable: true } as Record<string, unknown>,
  patch: vi.fn(),
}))
vi.mock("electron", () => ({ dialog: {} }))
vi.mock("@vykor/server", () => ({
  exportPortableSettings: vi.fn(),
  parsePortableSettings: vi.fn(),
}))
vi.mock("../session/session-service", () => ({
  desktopSessionService: {
    daemonClient: async () => ({
      system: { getSettings: async () => state.settings, patchSettings: state.patch },
    }),
  },
}))
import { ConfigurationSettingsService } from "./configuration-settings-service"
beforeEach(() => {
  state.settings = { maxTurns: 50, maxTurnsEditable: true }
  state.patch.mockReset().mockImplementation(async (patch) => {
    state.settings = { ...state.settings, maxTurns: patch.maxTurns }
  })
})
it("forwards the limit and read-time value for atomic saving", async () => {
  const service = new ConfigurationSettingsService()
  expect(await service.updateLimits({ maxTurns: 75, expectedMaxTurns: 50 })).toMatchObject({
    maxTurns: 75,
    editable: true,
  })
  expect(state.patch).toHaveBeenCalledWith({ maxTurns: 75, expectedMaxTurns: 50 })
})
it("refuses read-only, unsupported and stale changes before writing", async () => {
  const service = new ConfigurationSettingsService()
  state.settings = { maxTurns: 77, maxTurnsEditable: false, maxTurnsReason: "启动参数固定" }
  await expect(service.updateLimits({ maxTurns: 80, expectedMaxTurns: 77 })).rejects.toThrow(
    "启动参数固定"
  )
  state.settings = { maxTurns: 50 }
  await expect(service.updateLimits({ maxTurns: 80, expectedMaxTurns: 50 })).rejects.toThrow(
    /未提供/
  )
  state.settings = { maxTurns: 60, maxTurnsEditable: true }
  await expect(service.updateLimits({ maxTurns: 80, expectedMaxTurns: 50 })).rejects.toThrow(
    /已被其他入口修改/
  )
  expect(state.patch).not.toHaveBeenCalled()
})
