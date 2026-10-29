import { describe, expect, it } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"

import { resolveScrollerAgentStatus } from "../scroller-agent-status"

describe("resolveScrollerAgentStatus", () => {
  it("returns null when the agent is idle", () => {
    expect(
      resolveScrollerAgentStatus({
        running: false,
        pendingPermissionCount: 1,
        agentTaskRunning: true,
        parts: [toolPart({ toolName: "Read", status: "running" })],
      })
    ).toBeNull()
  })

  it("prefers a pending permission over an in-flight tool", () => {
    expect(
      resolveScrollerAgentStatus({
        running: true,
        pendingPermissionCount: 1,
        parts: [toolPart({ toolName: "Bash", status: "running", input: { command: "ls" } })],
      })
    ).toEqual({ kind: "permission", title: "等待授权" })
  })

  it("uses the latest in-flight tool summary", () => {
    expect(
      resolveScrollerAgentStatus({
        running: true,
        parts: [
          toolPart({
            id: "old",
            seq: 1,
            toolName: "Read",
            status: "running",
            input: { path: "a.ts" },
          }),
          toolPart({
            id: "current",
            seq: 2,
            toolName: "Bash",
            status: "pending",
            input: { command: "pnpm test" },
          }),
          toolPart({
            id: "done",
            seq: 3,
            toolName: "Read",
            status: "completed",
            input: { path: "b.ts" },
          }),
        ],
      })
    ).toEqual({ kind: "tool", title: "运行命令 · pnpm test" })
  })

  it("falls back to a running sub-agent, then a generic processing label", () => {
    expect(
      resolveScrollerAgentStatus({
        running: true,
        agentTaskRunning: true,
      })
    ).toEqual({ kind: "agent", title: "子智能体运行中" })
    expect(resolveScrollerAgentStatus({ running: true })).toEqual({
      kind: "processing",
      title: "正在处理",
    })
  })
})

function toolPart({
  id = "part-1",
  seq = 1,
  toolName,
  status,
  input = {},
}: {
  id?: string
  seq?: number
  toolName: string
  status: DesktopSessionPart["status"]
  input?: Record<string, unknown>
}): DesktopSessionPart {
  return {
    id,
    sessionId: "session-1",
    messageId: "message-1",
    seq,
    type: "tool",
    status,
    toolName,
    input,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

it("recognizes a streaming answer and a settled tool result instead of reporting a stale call", () => {
  const call = toolPart({ toolName: "Bash", status: "running" })
  call.toolUseId = "call"
  const result = {
    ...call,
    id: "result",
    type: "tool_result" as const,
    status: "completed" as const,
    seq: 2,
  }
  const text = { ...call, id: "answer", type: "text" as const, seq: 3, text: "正在回答" }
  expect(resolveScrollerAgentStatus({ running: true, parts: [call, result, text] })).toEqual({
    kind: "generating",
    title: "正在生成回复",
  })
})
