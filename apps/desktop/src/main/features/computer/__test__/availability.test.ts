import { afterEach, expect, it, vi } from "vitest"

const { statSync, app } = vi.hoisted(() => ({
  statSync: vi.fn(),
  app: { isPackaged: true, getAppPath: () => "C:/workspace/desktop" },
}))
vi.mock("node:fs", () => ({ statSync }))
vi.mock("electron", () => ({ app }))

import { computerAvailability } from "../availability"

afterEach(() => {
  vi.unstubAllEnvs()
  statSync.mockReset()
  app.isPackaged = true
})

it.runIf(process.platform === "win32" && process.arch === "x64")("keeps the packaged pilot off and refuses incomplete resources", () => {
  vi.stubEnv("VYKOR_COMPUTER_USE", undefined)
  expect(computerAvailability()).toBe("disabled")
  expect(statSync).not.toHaveBeenCalled()
  vi.stubEnv("VYKOR_COMPUTER_USE", "1")
  Object.defineProperty(process, "resourcesPath", { value: "C:/test/resources", configurable: true })
  try {
    statSync.mockReturnValueOnce({ isFile: () => true })
    expect(computerAvailability()).toBe("missing_driver")
    statSync.mockReturnValue({ isFile: () => true })
    expect(computerAvailability()).toBe("ready")
  } finally {
    Reflect.deleteProperty(process, "resourcesPath")
  }
})

it.runIf(process.platform === "win32" && process.arch === "x64")("allows the local driver in development and supports explicit opt-out", () => {
  app.isPackaged = false
  vi.stubEnv("VYKOR_COMPUTER_USE", undefined)
  statSync.mockReturnValue({ isFile: () => true })
  expect(computerAvailability()).toBe("ready")
  vi.stubEnv("VYKOR_COMPUTER_USE", "0")
  expect(computerAvailability()).toBe("disabled")
})
