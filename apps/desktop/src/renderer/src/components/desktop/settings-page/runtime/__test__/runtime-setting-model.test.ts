import { describe, expect, it } from "vitest"

import { runtimeEnvironmentLabel, runtimeEnvironmentNotice } from "../runtime-setting-model"

describe("runtime setting model", () => {
  it("labels every persisted environment state", () => {
    expect(runtimeEnvironmentLabel("native")).toBe("本机")
    expect(runtimeEnvironmentLabel("wsl")).toBe("WSL")
  })

  it("explains whether an environment change needs a restart", () => {
    expect(runtimeEnvironmentNotice(true)).toContain("重启")
    expect(runtimeEnvironmentNotice(false)).toBeNull()
  })
})
