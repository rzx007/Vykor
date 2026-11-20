import { expect, it, vi } from "vitest"
vi.mock("electron", () => ({ app: {}, dialog: {} }))
import * as settings from "../data-root-settings-service"

it("relaunches twice without turning internally injected directory values into external pins", () => {
  expect(settings).toHaveProperty("dataRootRelaunchEnvironment")
  const inherited = { VYKOR_CONFIG_DIR: "old", VYKOR_DATA_DIR: "old/data", KEEP: "yes" }
  const first = settings.dataRootRelaunchEnvironment(inherited, { homeDir: "unused", environment: {} })
  expect(first).toEqual({ KEEP: "yes" })
  const second = settings.dataRootRelaunchEnvironment({ ...first, VYKOR_CONFIG_DIR: "second" }, { homeDir: "unused", environment: {} })
  expect(second).toEqual({ KEEP: "yes" })
  expect(settings.dataRootRelaunchEnvironment(inherited, { homeDir: "unused", environment: { VYKOR_CONFIG_DIR: "external" } })).toEqual({ KEEP: "yes", VYKOR_CONFIG_DIR: "external" })
})
