// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopWorkflowRun, DesktopWorkflowTask } from "@shared/workflow-types"
import type { DesktopSessionPart } from "@shared/session-types"
import type { DesktopSessionTask } from "@shared/session-types"
import { buildAssistantContent } from "../../../conversation-page/message/models/message-render-model"
import { WorkflowProvider } from "../workflow-provider"
import { WorkflowSummary } from "../workflow-summary"
import { WorkflowTool } from "../workflow-tool"
import { findWorkflowSourcePart } from "../workflow-model"
import { WorkflowDetails } from "../workflow-details"
import InstalledTaskRows from "../../../../../../../components/primitives/TaskRows"
import { TaskRows as DesktopTaskRows } from "@renderer/components/agents/task-rows"

function task(
  id: string,
  status: DesktopWorkflowTask["status"],
  dependencies: string[] = []
): DesktopWorkflowTask {
  return {
    id,
    title: id,
    status,
    dependencies,
    changedFiles: [],
    writeScope: [],
    waitingForTaskIds: [],
    timedOut: false,
    cleanupUnconfirmed: false,
  }
}
const run: DesktopWorkflowRun = {
  id: "w1",
  jobId: "w1",
  target: { kind: "workflow", jobId: "w1" },
  sessionId: "main",
  title: "编排",
  status: "running",
  summary: "",
  canCancel: true,
  startedAt: 1,
  updatedAt: 2,
  detailsAvailable: true,
  needsReconciliation: false,
  reconciliationIssues: [],
  events: [],
  eventsTruncated: false,
  tasks: [task("接口", "failed"), task("界面", "running"), task("验收", "skipped", ["接口"])],
}
const call = {
  id: "tool",
  sessionId: "main",
  messageId: "message",
  seq: 1,
  createdAt: 1,
  updatedAt: 2,
  type: "tool",
  toolName: "Workflow",
  input: { action: "run" },
  status: "completed",
  output: '{"kind":"job","jobKind":"workflow","jobId":"w1","action":"created"}',
  metadata: {},
} as DesktopSessionPart
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
})

async function mount(content: React.ReactNode, onOpen = vi.fn(), selectedRun = run) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      workflows: {
        read: async () => ({ sessionId: "main", runs: [selectedRun], hasMore: false, errors: [] }),
        cancel: async () => {},
      },
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await act(async () =>
    root.render(
      <WorkflowProvider sessionId="main" revision={0} syncStatus="connected" onOpen={onOpen}>
        {content}
      </WorkflowProvider>
    )
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 130))
  })
  return container
}

it("routes only creating/resuming Workflow tools into the dedicated summary", () => {
  expect(buildAssistantContent([call])[0].type).toBe("workflow")
  expect(buildAssistantContent([{ ...call, input: { action: "history" } }])[0].type).toBe("tool")
})

it("uses the installed Task Rows component directly", () => {
  expect(DesktopTaskRows).toBe(InstalledTaskRows)
})

it("keeps live task status stable and links controls even when a task ID contains spaces", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  try {
    await act(async () =>
      root.render(
        <InstalledTaskRows
          rows={[
            {
              key: "task one",
              label: "评估报告",
              amount: "29 秒",
              status: "failed",
              statusLabel: "失败",
              details: [],
            },
          ]}
        />
      )
    )
    const trigger = container.querySelector<HTMLButtonElement>("button")!
    for (const attribute of ["aria-controls", "aria-describedby"]) {
      const target = trigger.getAttribute(attribute)!
      expect(target).not.toMatch(/\s/)
      expect(document.getElementById(target)).not.toBeNull()
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(trigger.textContent).toContain("失败")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
  } finally {
    vi.useRealTimers()
  }
})

it("expands Task Rows inline without changing real execution states or opening the task graph", async () => {
  const container = await mount(
    <WorkflowTool active onOpenFile={() => {}} onOpenAgents={() => {}} onOpenReview={() => {}} />
  )
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="展开任务：接口"]')!
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toContain(
    "失败"
  )
  await act(async () => trigger.click())
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  expect(container.querySelector('[aria-label="查看任务：接口"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="任务关系图"]')).toBeNull()
  expect(trigger.textContent).toContain("失败")
  await act(async () => trigger.click())
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(container.querySelector('[aria-label="查看任务：接口"]')).toBeNull()
})

it("finds the source call through a separate previewed result rather than a history query", () => {
  const source = { ...call, toolUseId: "use", output: undefined }
  const history = { ...call, id: "history", input: { action: "history", runId: "w1" } }
  const result = {
    ...call,
    id: "result",
    type: "tool_result" as const,
    toolName: undefined,
    toolUseId: "use",
    output: undefined,
    metadata: { workflowRunId: "w1" },
  }
  expect(findWorkflowSourcePart([history, source, result], "main", "w1")?.id).toBe("tool")
  expect(findWorkflowSourcePart([source, result], "other", "w1")).toBeUndefined()
})

it("opens isolated changes with the worktree root and leaves repair text in a scoped draft", async () => {
  const review = vi.fn()
  const isolated = {
    ...run,
    tasks: [{ ...run.tasks[0], worktreePath: "D:/isolated", changedFiles: ["src/login.ts"] }],
  }
  const draft = vi.fn()
  window.addEventListener("desktop:add-to-composer", draft)
  try {
    const container = await mount(
      <WorkflowTool active onOpenFile={() => {}} onOpenAgents={() => {}} onOpenReview={review} />,
      vi.fn(),
      isolated
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("让 Agent 处理"))!
        .click()
    )
    expect((draft.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      sessionId: "main",
      text: expect.stringContaining("w1"),
    })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="展开任务：接口"]')!.click()
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="查看任务：接口"]')!.click()
    )
    await act(async () =>
      (
        [...container.querySelectorAll('[role="tab"]')].find(
          (tab) => tab.getAttribute("aria-label") === "产出"
        ) as HTMLButtonElement
      ).click()
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "查看改动")!
        .click()
    )
    expect(review).toHaveBeenCalledWith("src/login.ts", "D:/isolated")
  } finally {
    window.removeEventListener("desktop:add-to-composer", draft)
  }
})

it("shows live running status after the tool settled, and opens the failed node", async () => {
  const open = vi.fn()
  const container = await mount(<WorkflowSummary call={call} />, open)
  expect(container.textContent).toContain("运行中")
  expect(container.textContent).toContain("失败 1")
  expect(
    [...container.querySelectorAll("button")]
      .filter((button) => button.textContent?.includes("查看"))
      .map((button) => button.textContent)
  ).toEqual(["查看失败节点"])
  const button = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("查看失败")
  )!
  await act(async () => button.click())
  expect(open).toHaveBeenCalledOnce()
})

it("links each raw-call disclosure to its own content without opening the workflow panel", async () => {
  const open = vi.fn()
  const container = await mount(
    <>
      <WorkflowSummary call={call} />
      <WorkflowSummary call={{ ...call, id: "second-call" }} />
    </>,
    open
  )
  const triggers = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) =>
      button.textContent?.includes("原始调用") || button.getAttribute("aria-label") === "原始调用"
  )
  expect(triggers).toHaveLength(2)
  const ids = triggers.map((button) => button.getAttribute("aria-controls"))
  expect(ids.every(Boolean)).toBe(true)
  expect(new Set(ids).size).toBe(2)
  const details = ids.map((id) => document.getElementById(id!)!)
  expect(details.every((element) => element.getAttribute("aria-hidden") === "true")).toBe(true)
  expect(container.querySelector("pre")).toBeNull()

  await act(async () => {
    triggers[0].focus()
    triggers[0].click()
  })
  expect(triggers[0].getAttribute("aria-expanded")).toBe("true")
  expect(details[0].getAttribute("aria-hidden")).toBe("false")
  expect(details[0].querySelector("pre")?.textContent).toContain('"action": "run"')
  expect(details[1].getAttribute("aria-hidden")).toBe("true")
  expect(open).not.toHaveBeenCalled()

  await act(async () => triggers[0].click())
  expect(triggers[0].getAttribute("aria-expanded")).toBe("false")
  expect(details[0].getAttribute("aria-hidden")).toBe("true")
  expect(container.querySelector("pre")).toBeNull()
  expect(document.activeElement).toBe(triggers[0])
})

it("reveals the graph when a chat failure link is used while the event tab is open", async () => {
  const container = await mount(
    <>
      <WorkflowSummary call={call} />
      <WorkflowTool active onOpenFile={() => {}} onOpenAgents={() => {}} onOpenReview={() => {}} />
    </>
  )
  await act(async () =>
    (
      [...container.querySelectorAll('[role="tab"]')].find(
        (tab) => tab.getAttribute("aria-label") === "事件"
      ) as HTMLButtonElement
    ).click()
  )
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("查看失败节点"))!
      .click()
  )
  expect(
    [...container.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) =>
      tab.getAttribute("aria-label")
    )
  ).toContain("任务图")
})

it("locates the failed task and highlights its downstream without selecting the parallel branch", async () => {
  const container = await mount(
    <WorkflowTool active onOpenFile={() => {}} onOpenAgents={() => {}} onOpenReview={() => {}} />
  )
  const button = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("定位失败")
  )!
  await act(async () => button.click())
  expect(container.querySelector('[data-workflow-node="接口"]')?.getAttribute("aria-pressed")).toBe(
    "true"
  )
  expect(
    container.querySelector('[data-workflow-node="验收"]')?.getAttribute("data-affected")
  ).toBe("true")
  expect(
    container.querySelector('[data-workflow-node="界面"]')?.getAttribute("data-affected")
  ).toBe("false")
})

it("opens completed runs on results, keeps full instructions hidden, and opens returned files", async () => {
  const openFile = vi.fn()
  const completed = {
    ...run,
    status: "completed" as const,
    canCancel: false,
    tasks: [
      {
        ...task("报告", "completed"),
        prompt: "需要执行的完整原始要求",
        result: "报告已保存。\n- 路径：`C:\\交付\\report.md`",
      },
      {
        ...task("PPT", "completed", ["报告"]),
        result: "演示稿返回正文\n- 路径：`C:\\交付\\presentation.pptx`",
      },
    ],
  }
  const container = await mount(
    <>
      <WorkflowSummary call={call} />
      <WorkflowTool active onOpenFile={openFile} onOpenAgents={() => {}} onOpenReview={() => {}} />
    </>,
    vi.fn(),
    completed
  )
  expect(container.textContent).toContain("编排已完成")
  expect(container.querySelector('[aria-label="返回结果中的文件"]')).not.toBeNull()
  expect(container.textContent).not.toContain("路径来自任务返回内容")
  expect(container.textContent).not.toContain("运行信息与来源")
  expect(container.textContent).not.toContain("需要执行的完整原始要求")
  expect(container.textContent).not.toContain("演示稿返回正文")
  expect(container.textContent).not.toContain("运行 0")
  expect(container.querySelector('[aria-label="节点详情"]')).toBeNull()
  expect(container.querySelector('[aria-label="任务关系图"]')).toBeNull()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="打开文件：presentation.pptx"]')!
      .click()
  )
  expect(openFile).toHaveBeenCalledWith("C:\\交付\\presentation.pptx")
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="展开任务：报告"]')!.click()
  )
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="查看任务：报告"]')!.click()
  )
  expect(container.querySelector('[data-workflow-node="PPT"]')?.getAttribute("data-affected")).toBe(
    "false"
  )
  expect(container.textContent).not.toContain("需要执行的完整原始要求")
  await act(async () =>
    (
      [...container.querySelectorAll('[role="tab"]')].find(
        (tab) => tab.getAttribute("aria-label") === "概况"
      ) as HTMLButtonElement
    ).click()
  )
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "完整任务要求")!
      .click()
  )
  expect(container.textContent).toContain("需要执行的完整原始要求")
  const close = container.querySelector<HTMLButtonElement>('[aria-label="收起节点详情"]')!
  await act(async () => {
    close.focus()
    close.click()
  })
  expect(container.querySelector('[aria-label="节点详情"]')).toBeNull()
  expect(document.activeElement?.getAttribute("data-workflow-node")).toBe("报告")
})

it("puts the failure and next action ahead of execution details", async () => {
  const container = await mount(
    <WorkflowTool active onOpenFile={() => {}} onOpenAgents={() => {}} onOpenReview={() => {}} />,
    vi.fn(),
    { ...run, tasks: [{ ...run.tasks[0], error: "连接被拒绝" }, ...run.tasks.slice(1)] }
  )
  const focus = container.querySelector('[aria-label="当前重点"]')!
  expect(focus.textContent).toContain("需要处理")
  expect(focus.textContent).toContain("连接被拒绝")
  expect(focus.textContent).toContain("定位失败")
  expect(container.querySelector('[aria-label="节点详情"]')).toBeNull()
})

it("keeps an unconfirmed stop reason in the repair draft without requiring node selection", async () => {
  const draft = vi.fn()
  window.addEventListener("desktop:add-to-composer", draft)
  try {
    const container = await mount(
      <WorkflowTool active onOpenFile={() => {}} onOpenAgents={() => {}} onOpenReview={() => {}} />,
      vi.fn(),
      {
        ...run,
        status: "killed",
        canCancel: false,
        tasks: [{ ...task("报告", "killed"), cleanupUnconfirmed: true, error: "停止请求未获确认" }],
      }
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "让 Agent 处理")!
        .click()
    )
    expect((draft.mock.calls[0][0] as CustomEvent).detail.text).toContain("停止请求未获确认")
    expect((draft.mock.calls[0][0] as CustomEvent).detail.text).toContain("未确认停止")
  } finally {
    window.removeEventListener("desktop:add-to-composer", draft)
  }
})

it("lets a task waiting for input open its child Agent directly from the overview", async () => {
  const openAgents = vi.fn()
  const waiting = { ...task("报告", "running"), needsInput: true, workerTaskId: "child" }
  const container = await mount(
    <WorkflowDetails
      run={run}
      task={waiting}
      agentTasks={[{ id: "child", childSessionId: "child-session" } as DesktopSessionTask]}
      onSelect={() => {}}
      onOpenFile={() => {}}
      onOpenReview={() => {}}
      onOpenAgents={openAgents}
      onClose={() => {}}
    />
  )
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("前往子 Agent 处理"))!
      .click()
  )
  expect(openAgents).toHaveBeenCalledWith("child")
})

it.each(["src/result.md", "./src/result.md", "../result.md"])(
  "shows returned file references as text instead of guessing a main-project path (%s)",
  async (path) => {
    const openFile = vi.fn()
    const completed = {
      ...task("报告", "completed"),
      worktreePath: "D:/isolated",
      result: `[结果文件](${path})`,
    }
    const container = await mount(
      <WorkflowDetails
        run={run}
        task={completed}
        onSelect={() => {}}
        onOpenFile={openFile}
        onOpenReview={() => {}}
        onOpenAgents={() => {}}
        onClose={() => {}}
      />
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "完整返回结果")!
        .click()
    )
    expect(container.querySelector(".assistant-markdown")?.textContent).toContain("结果文件")
    expect(container.querySelector(".assistant-file-link")).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  }
)
