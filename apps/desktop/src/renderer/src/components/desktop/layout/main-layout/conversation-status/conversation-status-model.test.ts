import { describe, expect, it } from "vitest"
import type {
  DesktopStandardSessionPart,
  DesktopSessionRun,
  DesktopSessionView,
} from "@shared/session-types"
import { resolveConversationStatus } from "./conversation-status-model"

function view(): DesktopSessionView {
  return {
    cursor: 1,
    syncStatus: "connected",
    session: {
      id: "chat",
      title: "当前聊天",
      cwd: "D:/work",
      model: "test",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

function run(
  id: string,
  status: DesktopSessionRun["status"],
  createdAt: number,
  inputId = id
): DesktopSessionRun {
  return {
    id,
    sessionId: "chat",
    inputId,
    status,
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    ...(status === "pending" ? {} : { startedAt: createdAt }),
    ...(["completed", "failed", "interrupted"].includes(status)
      ? { finishedAt: createdAt + 5_000 }
      : {}),
  }
}

function addMessage(
  snapshot: DesktopSessionView,
  runId: string,
  seq: number,
  parts: Partial<DesktopStandardSessionPart>[]
) {
  const messageId = `message-${seq}`
  snapshot.messages.push({
    id: messageId,
    sessionId: "chat",
    runId,
    role: "assistant",
    seq,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  })
  snapshot.parts.push(
    ...parts.map((part, index) => ({
      id: `${messageId}-${index}`,
      messageId,
      sessionId: "chat",
      type: "text" as const,
      status: "completed" as const,
      seq: index + 1,
      metadata: {},
      createdAt: seq,
      updatedAt: seq,
      ...part,
    }))
  )
}

describe("maximized workspace conversation status", () => {
  it("does not show an empty shell or a snapshot from another chat", () => {
    expect(resolveConversationStatus(null, "chat")).toBeNull()
    expect(resolveConversationStatus(view(), "chat")).toBeNull()
    const snapshot = view()
    snapshot.runs = [run("active", "running", 10_000)]
    expect(resolveConversationStatus(snapshot, "other")).toBeNull()
    expect(resolveConversationStatus(snapshot, null)).toBeNull()
    snapshot.session.status = "archived"
    expect(resolveConversationStatus(snapshot, "chat")).toBeNull()
  })

  it("keeps the running task ahead of newer queued input and older tools", () => {
    const snapshot = view()
    snapshot.runs = [
      run("old", "completed", 1_000),
      run("active", "running", 10_000),
      run("queued", "pending", 20_000),
    ]
    addMessage(snapshot, "old", 1, [
      { type: "tool", toolName: "Read", status: "running", input: { path: "old.ts" } },
    ])
    addMessage(snapshot, "active", 2, [
      { text: "正在检查布局\n和状态同步。" },
      { type: "reasoning", text: "隐藏推理" },
      { type: "tool_result", text: "原始输出" },
    ])
    addMessage(snapshot, "queued", 3, [{ text: "不能覆盖当前进度" }])
    expect(resolveConversationStatus(snapshot, "chat")).toMatchObject({
      kind: "processing",
      summary: "正在检查布局 和状态同步。",
      canStop: true,
      dismissible: false,
      timing: { startedAt: 10_000, status: "running" },
    })
  })

  it("summarizes a current tool without exposing its result, and stops treating returned tools as active", () => {
    const snapshot = view()
    snapshot.runs = [run("active", "running", 10_000)]
    addMessage(snapshot, "active", 1, [
      { text: "检查布局" },
      {
        type: "tool",
        toolName: "Read",
        status: "running",
        toolUseId: "read",
        input: { path: "layout.tsx" },
        output: "不能展示的输出",
      },
    ])
    expect(resolveConversationStatus(snapshot, "chat")?.summary).toBe("读取文件 · layout.tsx")
    snapshot.parts.push({
      ...snapshot.parts[1]!,
      id: "result",
      seq: 3,
      type: "tool_result",
      status: "completed",
      text: "原始输出",
    })
    expect(resolveConversationStatus(snapshot, "chat")?.summary).toBe("检查布局")
  })

  it.each([false, true])(
    "shows pending human requests even without a running flag (question=%s)",
    (question) => {
      const snapshot = view()
      snapshot.runs = [run("active", "completed", 10_000)]
      snapshot.permissions = [
        {
          id: "permission",
          sessionId: "chat",
          runId: "active",
          toolName: question ? "AskUser" : "Shell",
          payload: question ? { input: { kind: "question", question: "选哪一种布局？" } } : {},
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
      ]
      expect(resolveConversationStatus(snapshot, "chat")).toMatchObject({
        kind: question ? "question" : "permission",
        dismissible: false,
      })
    }
  )

  it("recognizes a tool result stored in a later assistant message", () => {
    const snapshot = view()
    snapshot.runs = [run("active", "running", 10_000)]
    addMessage(snapshot, "active", 1, [
      { text: "检查布局" },
      {
        type: "tool",
        toolName: "Read",
        status: "running",
        toolUseId: "read",
        input: { path: "layout.tsx" },
      },
    ])
    addMessage(snapshot, "active", 2, [
      { type: "tool_result", toolUseId: "read", status: "completed", text: "原始结果" },
    ])
    expect(resolveConversationStatus(snapshot, "chat")?.summary).toBe("检查布局")
  })

  it("uses the persisted timing for the current input's continuation, not the whole chat", () => {
    const snapshot = view()
    snapshot.runs = [
      run("old", "completed", 1_000),
      run("first", "completed", 10_000, "input"),
      run("continuation", "running", 20_000, "input"),
    ]
    expect(resolveConversationStatus(snapshot, "chat")?.timing).toEqual({
      status: "running",
      startedAt: 10_000,
    })
  })

  it("shows the oldest queued input without inventing elapsed time", () => {
    const snapshot = view()
    snapshot.runs = [run("second", "pending", 20_000), run("first", "pending", 10_000)]
    snapshot.inputs = [
      {
        id: "first",
        sessionId: "chat",
        seq: 1,
        delivery: "queue",
        content: "先处理布局",
        items: [],
        attachments: [],
        metadata: {},
        createdAt: 10_000,
      },
    ]
    expect(resolveConversationStatus(snapshot, "chat")).toMatchObject({
      kind: "queued",
      summary: "先处理布局",
      canStop: false,
      timing: { status: "pending" },
    })
  })

  it("retains the newest completed task and its final reply, not an earlier round", () => {
    const snapshot = view()
    snapshot.runs = [run("new", "completed", 10_000), run("old", "completed", 1_000)]
    addMessage(snapshot, "old", 1, [{ text: "旧结果" }])
    addMessage(snapshot, "new", 2, [{ text: "准备修改" }])
    addMessage(snapshot, "new", 3, [{ text: "已完成修改。", metadata: { phase: "final_answer" } }])
    expect(resolveConversationStatus(snapshot, "chat")).toMatchObject({
      kind: "completed",
      summary: "已完成修改。",
      dismissible: true,
      canStop: false,
      timing: { startedAt: 10_000, finishedAt: 15_000 },
    })
  })

  it.each(["failed", "interrupted"] as const)(
    "represents the terminal run status %s without raw errors",
    (status) => {
      const snapshot = view()
      snapshot.runs = [{ ...run("active", status, 10_000), error: "敏感内部错误" }]
      const result = resolveConversationStatus(snapshot, "chat")
      expect(result?.kind).toBe(status)
      expect(result?.summary).not.toContain("敏感内部错误")
      expect(result?.dismissible).toBe(true)
    }
  )

  it("does not turn a failed tool into a failed task", () => {
    const snapshot = view()
    snapshot.runs = [run("active", "running", 10_000)]
    addMessage(snapshot, "active", 1, [
      { type: "tool", toolName: "Read", status: "failed", isError: true, text: "失败" },
    ])
    expect(resolveConversationStatus(snapshot, "chat")?.kind).toBe("processing")
  })

  it("marks stale progress as reconnecting rather than reporting a fresh completion", () => {
    const snapshot = view()
    snapshot.runs = [run("active", "completed", 10_000)]
    snapshot.syncStatus = "reconnecting"
    expect(resolveConversationStatus(snapshot, "chat")).toMatchObject({
      kind: "reconnecting",
      canStop: false,
      dismissible: false,
    })
  })
})
