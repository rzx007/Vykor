import { describe, expect, it } from "vitest"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import {
  conversationActivity,
  summarizeToolCall,
  toolActivityLabel,
  toolGroupCompletedLabel,
  toolGroupHeaderLabel,
  toolGroupLatestLabel,
} from "../message-render-model"

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

describe("inline tool group wording", () => {
  it.each([
    "TeamCreate",
    "TeamDelete",
    "ScheduleCreate",
    "ScheduleDelete",
    "mcp__calendar__create_event",
    "mcp__remote__exec_query",
    "CustomTool",
  ])("keeps non-file operations neutral: %s", (toolName) => {
    expect(toolGroupCompletedLabel([{ call: { ...part, toolName, status: "completed" } }])).toBe(
      "操作已结束"
    )
  })

  it.each(["Write", "Edit", "ApplyPatch", "TodoWrite", "write_file"])(
    "still summarizes known file operations: %s",
    (toolName) => {
      expect(toolGroupCompletedLabel([{ call: { ...part, toolName, status: "completed" } }])).toBe(
        "编辑了文件"
      )
    }
  )

  it.each(["Shell", "BackgroundShellCreate", "TerminalOpen"])(
    "still summarizes known command operations: %s",
    (toolName) => {
      expect(toolGroupCompletedLabel([{ call: { ...part, toolName, status: "completed" } }])).toBe(
        "运行了命令"
      )
    }
  )

  it.each([
    [{}, "正在使用本地 OCR 识别文字"],
    [
      { attachmentOcr: { status: "completed", cached: true } },
      "已使用本地 OCR 提取文字 · 已复用识别结果",
    ],
  ])("preserves the complete OCR wording before the summary boundary: %j", (metadata, label) => {
    expect(toolGroupLatestLabel([{ call: { ...part, toolName: "ImageToText", metadata } }])).toBe(
      label
    )
  })

  it("uses the latest tool and its parameters before the summary boundary", () => {
    expect(
      toolGroupLatestLabel([
        { call: { ...part, toolName: "Edit", input: { path: "a.ts" }, status: "completed" } },
        { call: { ...part, id: "shell", toolName: "Shell", input: { command: "pnpm test" } } },
      ])
    ).toBe("运行命令 · pnpm test")
  })

  it("switches from the latest tool to the completed summary at the boundary", () => {
    const tools: { call: DesktopSessionPart; result?: DesktopSessionPart }[] = [
      { call: { ...part, toolName: "Edit", input: { path: "a.ts" }, status: "completed" } },
      {
        call: { ...part, id: "shell", toolName: "Shell", input: { command: "pnpm test" } },
        result: {
          ...part,
          id: "shell-result",
          type: "tool_result" as const,
          status: "completed" as const,
        },
      },
    ]
    expect(toolGroupHeaderLabel(tools, false)).toBe("运行命令 · pnpm test")
    expect(toolGroupHeaderLabel(tools, true)).toBe("编辑了文件，运行了命令")
  })
})

describe("built-in tool Chinese names", () => {
  it.each([
    ["Grep", "搜索文件内容"],
    ["JobList", "查看任务列表"],
    ["JobRead", "读取任务输出"],
    ["JobWait", "等待任务"],
    ["JobSend", "发送任务输入"],
    ["JobCancel", "停止任务"],
    ["Skill", "读取技能"],
    ["ListSkills", "查看技能列表"],
    ["ToolSearch", "查找工具"],
    ["ToolResult", "查看工具结果"],
    ["TodoWrite", "更新待办清单"],
    ["AskUser", "询问用户"],
    ["Config", "管理配置"],
    ["Brief", "精简文本"],
    ["Sleep", "等待"],
    ["Lsp", "查询代码信息"],
    ["NotebookEdit", "编辑笔记本"],
    ["Workflow", "运行工作流"],
    ["TeamCreate", "创建协作团队"],
    ["TeamDelete", "删除协作团队"],
    ["ScheduleCreate", "创建定时任务"],
    ["ScheduleList", "查看定时任务"],
    ["ScheduleUpdate", "更新定时任务"],
    ["ScheduleDelete", "删除定时任务"],
    ["ScheduleRunNow", "立即运行定时任务"],
    ["EnterPlanMode", "进入规划模式"],
    ["ExitPlanMode", "退出规划模式"],
    ["EnterWorktree", "创建独立工作区"],
    ["ExitWorktree", "移除独立工作区"],
    ["McpToolCall", "调用外部工具"],
    ["ListMcpResources", "查看外部资源"],
    ["ReadMcpResource", "读取外部资源"],
    ["McpAuth", "配置外部工具认证"],
    ["FeishuPush", "发送飞书消息"],
  ])("uses the same Chinese name for %s in rows and group titles", (toolName, name) => {
    const call = { ...part, toolName }
    expect(summarizeToolCall(call)).toEqual({ name, detail: undefined })
    expect(toolGroupLatestLabel([{ call }])).toBe(name)
    expect(
      summarizeToolCall({
        ...call,
        id: "ui-tool-generation:test",
        input: { path: "unfinished" },
        metadata: { uiToolGeneration: true, toolProgress: { phase: "generating" } },
      })
    ).toEqual({ name })
  })

  it.each(["job_read", "JOB-READ", "JobRead"])("accepts normalized tool names: %s", (toolName) => {
    expect(summarizeToolCall({ ...part, toolName, input: { description: "task-1" } })).toEqual({
      name: "读取任务输出",
      detail: "task-1",
    })
  })

  it("keeps external and unknown tool names on the existing fallback", () => {
    expect(summarizeToolCall({ ...part, toolName: "mcp__custom__JobRead" }).name).toBe(
      "Mcp custom Job Read"
    )
    expect(summarizeToolCall({ ...part, toolName: "CustomAction" }).name).toBe("Custom Action")
  })
})

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
    expect(conversationActivity([run], [message], [tool])).toEqual({
      label: "正在处理",
      orb: "solving",
    })
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

it.each([
  ["text", "正在生成回复"],
  ["reasoning", "正在思考"],
] as const)("reports %s streaming after a returned tool", (type, label) => {
  const call = { ...part, toolUseId: "call", metadata: { toolProgress: { phase: "completed" } } }
  const text = { ...part, id: "writing", seq: 2, type, text: "content", metadata: {} }
  expect(conversationActivity([run], [message], [call, text])?.label).toBe(label)
})
