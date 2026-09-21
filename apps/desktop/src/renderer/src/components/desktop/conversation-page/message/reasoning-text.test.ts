import { describe, expect, it } from "vitest"
import { truncateReasoning } from "./reasoning-text"

describe("truncateReasoning", () => {
  it("keeps short text unchanged", () => {
    expect(truncateReasoning("想法", 20000)).toEqual({ text: "想法", omitted: 0 })
  })

  it("keeps the tail and reports how much was omitted", () => {
    const long = "a".repeat(20005)
    const result = truncateReasoning(long, 20000)
    expect(result.text).toHaveLength(20000)
    expect(result.text).toBe(long.slice(-20000))
    expect(result.omitted).toBe(5)
  })
})
