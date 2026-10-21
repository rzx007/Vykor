import { expect, it } from "vitest"
import { SessionSummaryAttention } from "../session-summary-attention"

it("announces a new identity once, including after dismissal, removal and reappearance", () => {
  const attention = new SessionSummaryAttention(100, ["app:existing"])
  expect(attention.observe([{ key: "app:existing" }])).toBe(false)
  expect(attention.observe([{ key: "app:new" }])).toBe(true)
  expect(attention.observe([{ key: "app:new" }])).toBe(false)
  attention.observe([])
  expect(attention.observe([{ key: "app:new" }])).toBe(false)
  expect(attention.observe([{ key: "terminal:next", startedAt: 101 }])).toBe(true)
})

it("ignores late historical reads and invalid timestamps, but announces genuinely new work", () => {
  const attention = new SessionSummaryAttention(100)
  expect(attention.observe([{ key: "workflow:old", startedAt: 50 }])).toBe(false)
  expect(attention.observe([{ key: "terminal:unknown", startedAt: NaN }])).toBe(false)
  expect(attention.observe([{ key: "workflow:new", startedAt: 110 }])).toBe(true)
  expect(attention.observe([{ key: "workflow:new", startedAt: 110 }])).toBe(false)
})

it("a new chat visit baselines resident apps and ignores old jobs again", () => {
  const attention = new SessionSummaryAttention(200, ["app:new"])
  expect(attention.observe([{ key: "app:new" }, { key: "workflow:new", startedAt: 110 }])).toBe(
    false
  )
})
