import { describe, expect, it } from "vitest"
import type { SessionGoal } from "@shared/session-types"
import { goalStopReasonLabel } from "../goal-stop-reason-label"

describe("goalStopReasonLabel", () => {
  const goal: SessionGoal = { id: "g", sessionId: "s", objective: "finish", objectiveVersion: 1,
    phase: "executing", requirements: [], stagnationCount: 0,
    revision: 0, status: "paused", maxAutoTurns: 2, autoTurnsUsed: 0, noProgressCount: 0,
    evidence: [], usage: { knownTokens: 0, incomplete: false, unknownAttempts: 0, partialAttempts: 0, inFlightAttempts: 0, runTimeMs: 0, seq: 0, updatedAt: 1 }, createdAt: 1, updatedAt: 1 }
  it("distinguishes timeout from exhausted automatic turns", () => {
    expect(goalStopReasonLabel({ ...goal, stopReason: { code: "wait_timeout", at: 1 } })).toBe("等待任务超时")
    expect(goalStopReasonLabel({ ...goal, stopReason: { code: "auto_turn_limit", at: 1 } })).toBe("自动续跑次数已用完")
    expect(goalStopReasonLabel({ ...goal, stopReason: { code: "preparation_incomplete", at: 1 } })).toBe("目标条件尚未明确")
    expect(goalStopReasonLabel({ ...goal, reason: "自由文本不决定停止代码" })).toBeUndefined()
  })
})
