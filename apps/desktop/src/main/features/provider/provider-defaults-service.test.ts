import { beforeEach, describe, expect, it, vi } from "vitest"
const { state, patch, testConnection, fingerprint } = vi.hoisted(() => ({
  state: { settings: {} as Record<string, unknown> }, patch: vi.fn(),
  testConnection: vi.fn(), fingerprint: vi.fn(),
}))
vi.mock("@vykor/server", () => ({ testStoredProviderConnection: testConnection, storedProviderConnectionFingerprint: fingerprint }))
vi.mock("../session/session-service", () => ({ desktopSessionService: { daemonClient: async () => ({
  system: { getSettings: async () => state.settings, patchSettings: patch },
  providers: { listModels: async () => [{ name: "gateway", displayName: "Gateway", models: [{ id: "model-1", label: "Model", provider: "Gateway", providerName: "gateway", reasoningEfforts: ["low", "high"], contextWindow: 10000 }] }] },
}) } }))
import { DesktopProviderDefaultsService } from "./provider-defaults-service"

beforeEach(() => {
  state.settings = { provider: "gateway", model: "model-1", effort: "low" }
  patch.mockReset(); patch.mockImplementation(async (value) => { state.settings = { ...state.settings, ...value }; return state.settings })
  fingerprint.mockReset(); fingerprint.mockResolvedValue("fingerprint-1")
  testConnection.mockReset(); testConnection.mockResolvedValue({ fingerprint: "fingerprint-1", checkedAt: 100 })
})

describe("provider defaults", () => {
  it("rejects unsupported efforts and stale revisions before changing defaults", async () => {
    const service = new DesktopProviderDefaultsService()
    const snapshot = await service.snapshot()
    await expect(service.updateEffort({ effort: "max", expectedRevision: snapshot.revision })).rejects.toThrow("不支持")
    expect(patch).not.toHaveBeenCalled()
    const saved = await service.updateEffort({ effort: "high", expectedRevision: snapshot.revision })
    expect(saved).toMatchObject({ provider: "gateway", model: "model-1", effort: "high", fastModeAvailable: false })
    await expect(service.updateEffort({ effort: null, expectedRevision: snapshot.revision })).rejects.toThrow("已变化")
  })

  it("marks only actual successful tests verified and invalidates results after credentials change", async () => {
    const service = new DesktopProviderDefaultsService()
    expect((await service.snapshot()).verified).toEqual({})
    expect(await service.test({ provider: "gateway", model: "model-1" })).toMatchObject({ status: "verified", checkedAt: 100 })
    expect((await service.snapshot()).verified).toEqual({ gateway: { model: "model-1", checkedAt: 100 } })
    fingerprint.mockResolvedValueOnce("new-credential")
    expect((await service.snapshot()).verified).toEqual({})
    testConnection.mockRejectedValueOnce(new Error("模型不支持：未列出"))
    expect(await service.test({ provider: "gateway", model: "model-1" })).toMatchObject({ status: "failed", category: "model" })
  })

  it("returns no effective default when new model tasks are explicitly disabled", async () => {
    state.settings.modelDisabled = true
    expect(await new DesktopProviderDefaultsService().snapshot()).toMatchObject({ disabled: true, provider: null, model: null })
  })
})
