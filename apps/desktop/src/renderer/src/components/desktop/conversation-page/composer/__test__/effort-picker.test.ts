import { describe, expect, it } from "vitest"

import { effortLabel, resolveEffortTiers } from "../effort-picker"

describe("effort picker", () => {
  it("maps known tiers to Chinese labels and falls back to raw", () => {
    expect(effortLabel("max")).toBe("最高")
    expect(effortLabel("low")).toBe("低")
    expect(effortLabel("weird")).toBe("weird")
  })

  it("resolves tiers from the selected model", () => {
    const models = [
      { id: "m", label: "M", provider: "P", providerName: "p", reasoningEfforts: ["low", "high"] },
    ] as never
    expect(resolveEffortTiers(models, "m", "p")).toEqual(["low", "high"])
    expect(resolveEffortTiers(models, "missing", "p")).toEqual([])
  })
})
