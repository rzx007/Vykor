import { expect, it, vi } from "vitest"
const exposed = vi.hoisted(() => new Map<string, unknown>())
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }, webUtils: {} }))
vi.mock("@electron-toolkit/preload", () => ({ electronAPI: { process: {} } }))
it("exposes only business export and bounded local maintenance in the legacy window", async () => {
  const argv = process.argv
  Object.defineProperty(process, "contextIsolated", { configurable: true, value: true })
  Object.defineProperty(process, "isMainFrame", { configurable: true, value: true })
  process.argv = [...argv, "--data-root-maintenance"]
  try {
    await import("../index")
    expect(exposed.has("electron")).toBe(false)
    const api = exposed.get("desktop") as Record<string, any>
    expect(Object.keys(api).sort()).toEqual(["businessData", "dataRootMaintenance", "maintenance"])
    expect(Object.keys(api.maintenance).sort()).toEqual(["chooseDirectory", "dataRootInfo", "inspectDataRoot", "migrateDataRoot", "recoverDataRoot"])
    expect(api).not.toHaveProperty("sessions")
    expect(api.businessData).toHaveProperty("acknowledgeUnresolvedComposer")
  } finally { process.argv = argv; delete (process as any).contextIsolated; delete (process as any).isMainFrame }
})
