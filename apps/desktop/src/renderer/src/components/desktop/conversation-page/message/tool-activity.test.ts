import { describe, expect, it } from "vitest"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import { conversationActivity, summarizeToolCall, toolActivityLabel } from "./message-render-model"

const run: DesktopSessionRun = {
  id: "run",
  sessionId: "s",
  status: "running",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}
const message: DesktopSessionMessage = {
  id: "m",
  sessionId: "s",
  seq: 1,
  runId: "run",
  role: "assistant",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}
const part: DesktopSessionPart = {
  id: "p",
  messageId: "m",
  sessionId: "s",
  seq: 1,
  type: "tool",
  toolName: "Write",
  status: "running",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}

describe("real tool activity labels", () => {
  it("labels a terminal unknown outcome as uncertain", () => {
    expect(
      toolActivityLabel({ ...part, status: "completed", metadata: { executionState: "unknown" } })
    ).toBe("结果不确定")
    expect(
      toolActivityLabel({ ...part, status: "failed", metadata: { failureKind: "unknown_outcome" } })
    ).toBe("结果不确定")
  })

  it.each([{ failureKind: "unknown_outcome" }, { outcome: "unknown" }])(
    "labels latest legacy unknown result before an older completed call: %j",
    (metadata) => {
      const call = {
        ...part,
        status: "completed" as const,
        metadata: { executionState: "completed" },
      }
      const result = {
        ...part,
        id: "result",
        type: "tool_result" as const,
        status: "completed" as const,
        metadata,
      }
      expect(toolActivityLabel(call, result)).toBe("结果不确定")
      expect(toolActivityLabel(call, { ...result, metadata: {}, output: metadata })).toBe(
        "结果不确定"
      )
    }
  )

  it("keeps waiting feedback without exposing raw parameter counts", () => {
    const generating = {
      ...run,
      metadata: { toolGeneration: [{ receivedChars: 8192 }, { receivedChars: 10 }] },
    }
    expect(conversationActivity([generating], [message], [])).toEqual({
      label: "正在处理",
      orb: "composing",
    })
    expect(
      conversationActivity([{ ...generating, status: "completed" }], [message], [])?.label
    ).toBeUndefined()
  })
  it.each([
    ["Write", "写入文件"],
    ["Read", "读取文件"],
    ["Edit", "编辑文件"],
    ["Shell", "运行命令"],
  ])(
    "uses the same Chinese action for a preparing %s without pretending its input is ready",
    (toolName, name) => {
      const preparing = {
        ...part,
        id: "ui-tool-generation:run:g:1:0",
        toolName,
        input: { path: "not-ready.ts" },
        metadata: {
          uiToolGeneration: true,
          toolProgress: {
            phase: "generating",
            executionState: "not_started",
            receivedChars: 15_201,
          },
        },
      }
      expect(summarizeToolCall(preparing)).toMatchObject({ name })
      expect(summarizeToolCall(preparing).detail).toBeUndefined()
      expect(toolActivityLabel(preparing)).toBe("准备中")
      expect(conversationActivity([run], [message], [preparing])).toEqual({
        label: "正在处理",
        orb: "composing",
      })
    }
  )
  it.each([
    ["preparing", "正在准备工具", "solving"],
    ["waiting_permission", "等待你的确认", "breathing"],
    ["queued", "等待前一个工具", "breathing"],
    ["running", "正在处理", "solving"],
    ["completed", "工具已返回，等待本轮结果", "working"],
    ["unknown", "结果不确定", "working"],
  ])("uses the expected activity label and orb for %s", (phase, want, orb) => {
    const tool = { ...part, metadata: { toolProgress: { phase } } }
    expect(conversationActivity([run], [message], [tool])).toEqual({ label: want, orb })
  })
  it("ignores a phase that only exists on Object.prototype", () => {
    const tool = { ...part, metadata: { toolProgress: { phase: "constructor" } } }
    expect(conversationActivity([run], [message], [tool])).toEqual({ label: "正在处理", orb: "solving" })
  })
  it("waits with breathing and thinks with working when no tool is involved", () => {
    expect(conversationActivity([run], [message], [])).toEqual({
      label: "等待模型响应",
      orb: "working",
    })
    expect(conversationActivity([run], [message], [{ ...part, status: "pending" }])).toEqual({
      label: "等待执行",
      orb: "breathing",
    })
  })
  it("stops reporting activity once no run is active", () => {
    expect(conversationActivity([], [message], [part])).toBeUndefined()
  })
  it("shows conversation feedback while keeping the tool row label blank", () => {
    expect(toolActivityLabel(part)).toBe("")
    expect(conversationActivity([run], [message], [part])).toEqual({
      label: "正在处理",
      orb: "solving",
    })
  })
  it("ignores terminal part metadata and tools from older runs", () => {
    const tool = { ...part, metadata: { toolProgress: { phase: "running" } } }
    expect(toolActivityLabel({ ...tool, status: "failed" })).toBe("失败")
    expect(conversationActivity([run], [{ ...message, runId: "old" }], [tool])?.label).toBe(
      "等待模型响应"
    )
    expect(conversationActivity([run], [message], [{ ...tool, status: "completed" }])?.label).toBe(
      "等待模型响应"
    )
  })
})
