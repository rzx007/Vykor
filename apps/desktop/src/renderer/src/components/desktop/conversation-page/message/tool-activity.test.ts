import { describe, expect, it } from "vitest"
import type { DesktopSessionMessage, DesktopSessionPart, DesktopSessionRun } from "@shared/session-types"
import { conversationActivityLabel, toolActivityLabel } from "./message-render-model"

const run: DesktopSessionRun = { id: "run", sessionId: "s", status: "running", metadata: {}, createdAt: 1, updatedAt: 1 }
const message: DesktopSessionMessage = { id: "m", sessionId: "s", seq: 1, runId: "run", role: "assistant", metadata: {}, createdAt: 1, updatedAt: 1 }
const part: DesktopSessionPart = { id: "p", messageId: "m", sessionId: "s", seq: 1, type: "tool", toolName: "Write", status: "running", metadata: {}, createdAt: 1, updatedAt: 1 }

describe("real tool activity labels", () => {
  it("shows raw parameter character counts only for an active run", () => {
    const generating = { ...run, metadata: { toolGeneration: [{ receivedChars: 8192 }, { receivedChars: 10 }] } }
    expect(conversationActivityLabel([generating], [message], [])).toContain("8,202")
    expect(conversationActivityLabel([generating], [message], [])).toContain("参数")
    expect(conversationActivityLabel([{ ...generating, status: "completed" }], [message], [])).toBeUndefined()
  })
  it.each([
    ["preparing", "正在准备工具"], ["waiting_permission", "等待你的确认"], ["queued", "等待前一个工具"],
    ["running", "正在执行工具"], ["completed", "工具已返回，等待本轮结果"], ["unknown", "结果不确定"],
  ])("uses %s instead of waiting for the model", (phase, want) => {
    const tool = { ...part, metadata: { toolProgress: { phase } } }
    expect(conversationActivityLabel([run], [message], [tool])).toBe(want)
  })
  it("ignores terminal part metadata and tools from older runs", () => {
    const tool = { ...part, metadata: { toolProgress: { phase: "running" } } }
    expect(toolActivityLabel({ ...tool, status: "failed" })).toBe("失败")
    expect(conversationActivityLabel([run], [{ ...message, runId: "old" }], [tool])).toBe("等待模型响应")
    expect(conversationActivityLabel([run], [message], [{ ...tool, status: "completed" }])).toBe("等待模型响应")
  })
})
