// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import type { DesktopWorkflowRun } from "@shared/workflow-types"
import type { DesktopTerminalRecord } from "@shared/terminal-types"
import type {
  DesktopSessionTask,
  DesktopSessionRun,
  DesktopSessionMessage,
  DesktopSessionPart,
} from "@shared/session-types"
import { PluginAppController } from "../../../shell/plugin-apps/controller"
import type { ResidentAppPage } from "../../../shell/plugin-apps/page-manager"
import { mount } from "../../../shell/plugin-apps/__test__/fixtures.test-support"
import { SessionSummaryPopover } from "../session-summary-popover"

const state = vi.hoisted(() => ({
  pages: [] as ResidentAppPage[],
  runs: [] as DesktopWorkflowRun[],
  terminals: [] as DesktopTerminalRecord[],
  tasks: [] as DesktopSessionTask[],
  sessionRuns: [] as DesktopSessionRun[],
  messages: [] as DesktopSessionMessage[],
  parts: [] as DesktopSessionPart[],
  workflowSession: "chat",
  confirming: false,
  focus: vi.fn(),
  openWorkflow: vi.fn(),
  openTerminal: vi.fn(),
  openApps: vi.fn(),
}))
vi.mock("../../../shell/plugin-apps/provider", () => ({
  usePluginApps: () => ({ focus: state.focus }),
  usePluginAppPages: () => state.pages,
  usePluginAppConfirming: () => state.confirming,
}))
vi.mock("../../../tools/workflows/workflow-provider", () => ({
  useWorkflows: () => ({
    sessionId: state.workflowSession,
    snapshot: { runs: state.runs },
    open: state.openWorkflow,
  }),
}))
vi.mock("../use-session-summary-terminals", () => ({
  useSessionSummaryTerminals: () => ({ records: state.terminals, error: null, loading: false }),
}))

let root: Root, container: HTMLDivElement
let enteredAt: number
beforeEach(() => {
  vi.clearAllMocks()
  state.pages = []
  state.runs = []
  state.terminals = []
  state.confirming = false
  state.workflowSession = "chat"
  state.tasks = []
  state.sessionRuns = []
  state.messages = []
  state.parts = []
  enteredAt = Date.now()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
async function render(id = "chat") {
  await act(async () => {
    const view = emptySessionView(id)
    view.tasks = state.tasks
    view.runs = state.sessionRuns
    view.messages = state.messages
    view.parts = state.parts
    root.render(
      <SessionSummaryPopover
        view={view}
        workspace={null}
        canOpenReview={false}
        onOpenReview={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenApps={state.openApps}
        onOpenTerminal={state.openTerminal}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}
async function click(label: string) {
  const button =
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === label
    )
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}
function isOpen() {
  return document.querySelector('[data-slot="popover-content"]') !== null
}
function app(id: string, sessionId = "chat"): ResidentAppPage {
  const controller = new PluginAppController(
    { ...mount, mountId: id, state: { ...mount.state, source: { sessionId, appId: id } } },
    {} as never,
    vi.fn()
  )
  return { id, title: id, controller, modes: ["inline"] }
}
function run(id: string, startedAt = enteredAt + 1): DesktopWorkflowRun {
  return {
    id,
    title: id,
    jobId: id,
    target: { kind: "workflow", jobId: id },
    sessionId: "chat",
    startedAt,
    updatedAt: startedAt,
    status: "running",
    tasks: [],
    summary: "",
    canCancel: true,
    detailsAvailable: false,
    needsReconciliation: false,
    reconciliationIssues: [],
    events: [],
    eventsTruncated: false,
  }
}
function terminal(id: string, startedAt = enteredAt + 1): DesktopTerminalRecord {
  return {
    id,
    name: id,
    command: "pnpm dev",
    cwd: "/repo",
    shell: "/bin/sh",
    scope: { kind: "session", sessionId: "chat" },
    sessionId: "chat",
    source: "agent",
    runtime: "local",
    status: "running",
    cols: 80,
    rows: 24,
    createdAt: new Date(startedAt).toISOString(),
  }
}

it("hides empty groups while leaving the explicit app catalogue action available", async () => {
  await render()
  await click("当前聊天的工作摘要")
  expect(document.querySelector('section[aria-label="聊天应用"]')).toBeNull()
  expect(document.querySelector('section[aria-label="聊天工作流和长任务"]')).toBeNull()
  expect(document.body.textContent).not.toContain("暂无")
  await click("打开应用")
  expect(state.openApps).toHaveBeenCalledOnce()
})

it.each(["escape", "trigger"])(
  "keeps the same item dismissed through %s while typing",
  async (method) => {
    await render()
    const editor = document.createElement("textarea")
    document.body.append(editor)
    editor.focus()
    const notes = app("Notes")
    state.pages = [notes]
    await render()
    expect(isOpen()).toBe(true)
    if (method === "trigger") await click("当前聊天的工作摘要")
    else
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    expect(isOpen()).toBe(false)
    state.pages = [{ ...notes, title: "Notes 更新" }]
    await render()
    expect(isOpen()).toBe(false)
    editor.remove()
  }
)

it("does not expose or announce stale workflow and shell state from another session", async () => {
  await render("other")
  state.workflowSession = "chat"
  state.runs = [run("foreign workflow", Date.now() + 1)]
  state.tasks = [
    {
      id: "foreign-shell",
      sessionId: "chat",
      type: "shell",
      status: "running",
      description: "foreign shell",
      cwd: "/repo",
      metadata: {},
      createdAt: Date.now() + 1,
      updatedAt: Date.now() + 1,
    },
  ]
  state.pages = [app("foreign app", "chat")]
  await render("other")
  expect(isOpen()).toBe(false)
  await click("当前聊天的工作摘要")
  expect(document.body.textContent).not.toContain("foreign")
})

it("auto-opens for a new app without focus theft or navigating, and dismisses the identity permanently", async () => {
  await render()
  const editor = document.createElement("textarea")
  document.body.append(editor)
  editor.focus()
  const notes = app("Notes")
  state.pages = [notes]
  await render()
  expect(isOpen()).toBe(true)
  expect(document.activeElement).toBe(editor)
  expect(state.focus).not.toHaveBeenCalled()
  expect(document.querySelector("iframe")).toBeNull()
  await click("收起工作摘要")
  expect(isOpen()).toBe(false)
  state.pages = [{ ...notes, title: "Notes · 更新" }]
  await render()
  expect(isOpen()).toBe(false)
  expect(document.activeElement).toBe(editor)
  state.pages = [notes, app("Inspector")]
  await render()
  expect(isOpen()).toBe(true)
  await click("打开Notes")
  expect(state.focus).toHaveBeenCalledExactlyOnceWith(notes)
  expect(isOpen()).toBe(false)
  editor.remove()
})

it("baselines resident apps, ignores other chats and late old jobs, but opens new work once", async () => {
  state.pages = [app("existing"), app("foreign", "other")]
  await render()
  expect(isOpen()).toBe(false)
  state.runs = [run("history", enteredAt - 1000)]
  state.terminals = [terminal("old terminal", enteredAt - 1000)]
  await render()
  expect(isOpen()).toBe(false)
  state.runs.push(run("new workflow", Date.now() + 1))
  await render()
  expect(isOpen()).toBe(true)
  expect(document.body.textContent).not.toContain("foreign")
  await click("打开new workflow")
  expect(state.openWorkflow).toHaveBeenCalledExactlyOnceWith("new workflow")
  state.runs = state.runs.map((item) => ({ ...item, status: "completed" }))
  await render()
  expect(isOpen()).toBe(false)
  state.terminals.push(terminal("build", Date.now() + 1))
  await render()
  expect(isOpen()).toBe(true)
  await click("打开build")
  expect(state.openTerminal).toHaveBeenCalledExactlyOnceWith("build")
  state.terminals = state.terminals.map((item) => ({ ...item, status: "failed" }))
  await render()
  expect(isOpen()).toBe(false)
})

it("defers new attention while a permission confirmation is open and reads the original controller state", async () => {
  await render()
  const notes = app("Notes")
  state.confirming = true
  state.pages = [notes]
  await render()
  expect(isOpen()).toBe(false)
  state.confirming = false
  await render()
  expect(isOpen()).toBe(true)
  await act(async () =>
    notes.controller.update({
      ...notes.controller.state,
      availability: {
        ...notes.controller.state.availability,
        canInvokeTools: false,
        canMessage: false,
        reason: "action-unconfirmed",
      },
    })
  )
  expect(document.body.textContent).toContain("操作结果待核实")
  await click("收起工作摘要")
  await act(async () => notes.controller.update({ ...notes.controller.state, online: false }))
  await render()
  expect(isOpen()).toBe(false)
})

it("closes when switching chat, baselines returning apps, and retains explicit catalogue access", async () => {
  await render()
  state.pages = [app("Notes")]
  await render()
  expect(isOpen()).toBe(true)
  state.workflowSession = "other"
  await render("other")
  expect(isOpen()).toBe(false)
  await click("当前聊天的工作摘要")
  expect(document.body.textContent).not.toContain("Notes")
  await click("打开应用")
  expect(state.openApps).toHaveBeenCalledOnce()
  expect(isOpen()).toBe(false)
  state.workflowSession = "chat"
  await render()
  expect(isOpen()).toBe(false)
})

it("omits shell jobs of every status, including current exceptions and history", async () => {
  state.sessionRuns = [
    { id: "retry", inputId: "current", createdAt: 30, status: "running" },
    { id: "future", inputId: "next", createdAt: 40, status: "pending" },
    { id: "old", inputId: "previous", createdAt: 10 },
    { id: "current", inputId: "current", createdAt: 20 },
  ].map((run) => ({
    status: "completed",
    ...run,
    sessionId: "chat",
    metadata: {},
    updatedAt: run.createdAt,
  })) as DesktopSessionRun[]
  state.tasks = [
    { id: "active", runId: "old", status: "running" },
    { id: "pending", runId: "retry", status: "pending" },
    { id: "failure", runId: "current", status: "failed" },
    { id: "interrupted", runId: "retry", status: "interrupted" },
    { id: "old-failure", runId: "old", status: "failed" },
    { id: "completed", runId: "retry", status: "completed" },
    { id: "unbound", status: "failed" },
    { id: "legacy", requestNamespace: "tool", requestId: "tool:legacy-call", status: "failed" },
  ].map((task) => ({
    ...task,
    sessionId: "chat",
    type: "shell",
    description: task.id,
    cwd: "/repo",
    output: `${task.id} output`,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  })) as DesktopSessionTask[]
  state.messages = [
    {
      id: "current-message",
      sessionId: "chat",
      role: "assistant",
      runId: "current",
      seq: 1,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  state.parts = [
    {
      id: "legacy-part",
      sessionId: "chat",
      messageId: "current-message",
      type: "tool",
      toolUseId: "legacy-call",
      seq: 1,
      status: "completed",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  await render()
  await click("当前聊天的工作摘要")
  const history = document.querySelector<HTMLDetailsElement>('details[aria-label="历史后台命令"]')
  expect(history).toBeNull()
  expect(document.querySelector('section[aria-label="聊天工作流和长任务"]')).toBeNull()
  for (const task of state.tasks) expect(document.body.textContent).not.toContain(task.output)
})

it("does not auto-open or announce detached shell jobs or subsequent status updates", async () => {
  await render()
  state.tasks = [
    {
      id: "build-job",
      sessionId: "chat",
      type: "shell",
      status: "running",
      description: "构建项目",
      cwd: "/repo",
      output: "正在编译",
      metadata: {},
      createdAt: Date.now() + 1,
      updatedAt: Date.now() + 1,
    },
  ]
  await render()
  expect(isOpen()).toBe(false)
  await click("当前聊天的工作摘要")
  expect(document.body.textContent).not.toContain("构建项目")
  expect(document.body.textContent).not.toContain("后台命令")
  expect(state.openTerminal).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain("正在编译")
  await click("收起工作摘要")
  state.tasks = state.tasks.map((task) => ({
    ...task,
    status: "completed",
    output: "构建成功",
    updatedAt: Date.now() + 2,
  }))
  await render()
  expect(isOpen()).toBe(false)
})
