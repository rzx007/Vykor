import { afterEach, expect, it, vi } from "vitest"

const { readFile, app, release, license } = vi.hoisted(() => ({
  readFile: vi.fn(),
  app: { isPackaged: true, getAppPath: () => "C:/workspace/desktop" },
  release: {
    executable: "cua-driver.exe",
    executableSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
  license: "fixture license",
}))
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()), readFile,
}))
vi.mock("electron", () => ({ app }))
const getDesktopPreferences = vi.hoisted(() => vi.fn<() => { computerEnabled?: boolean }>(() => ({})))
vi.mock("../../settings/desktop-preferences", () => ({ getDesktopPreferences }))
vi.mock("../../../../../resources/computer-windows/driver-release.json", () => ({ default: release }))
vi.mock("../../../../../resources/computer-windows/CUA-LICENSE.txt?raw", () => ({ default: license }))

import { computerAvailability, computerPlatformAvailability } from "../availability"

afterEach(() => {
  vi.unstubAllEnvs()
  readFile.mockReset()
  getDesktopPreferences.mockReset().mockReturnValue({})
  app.isPackaged = true
})

it.runIf(process.platform === "win32" && process.arch === "x64")("uses the saved switch over the launch default and honors forced disable", () => {
  vi.stubEnv("VYKOR_COMPUTER_USE", undefined)
  getDesktopPreferences.mockReturnValue({ computerEnabled: true })
  expect(computerPlatformAvailability()).toBe("enabled")
  vi.stubEnv("VYKOR_COMPUTER_USE", "0")
  expect(computerPlatformAvailability()).toBe("disabled")
  vi.stubEnv("VYKOR_COMPUTER_USE", "1")
  getDesktopPreferences.mockReturnValue({ computerEnabled: false })
  expect(computerPlatformAvailability()).toBe("disabled")
})

function fixtureResources(invalid?: "exe" | "json" | "txt") {
  readFile.mockImplementation(async (file: string) => {
    const ext = file.split(".").at(-1)
    if (ext === "exe") return Buffer.from(invalid === ext ? "corrupt" : "hello")
    if (ext === "json") return JSON.stringify(invalid === ext ? {} : release)
    if (ext === "txt") return invalid === ext ? "old license" : license
    throw new Error("Unexpected resource")
  })
}

it.runIf(process.platform === "win32" && process.arch === "x64")("keeps the packaged pilot off and checks the installed package when enabled", async () => {
  vi.stubEnv("VYKOR_COMPUTER_USE", undefined)
  expect(await computerAvailability()).toBe("disabled")
  expect(readFile).not.toHaveBeenCalled()
  vi.stubEnv("VYKOR_COMPUTER_USE", "1")
  Object.defineProperty(process, "resourcesPath", { value: "C:/test/resources", configurable: true })
  try {
    fixtureResources()
    expect(await computerAvailability()).toBe("ready")
    expect(readFile.mock.calls.every(([file]) => /resources[/\\]computer-windows[/\\]/.test(file))).toBe(true)
  } finally {
    Reflect.deleteProperty(process, "resourcesPath")
  }
})

it.runIf(process.platform === "win32" && process.arch === "x64")("reports a present but corrupted resource as unavailable on the next check", async () => {
  app.isPackaged = false
  vi.stubEnv("VYKOR_COMPUTER_USE", undefined)
  fixtureResources()
  expect(await computerAvailability()).toBe("ready")
  for (const invalid of ["exe", "json", "txt"] as const) {
    fixtureResources(invalid)
    expect(await computerAvailability()).toBe("missing_driver")
  }
  vi.stubEnv("VYKOR_COMPUTER_USE", "0")
  expect(await computerAvailability()).toBe("disabled")
})
