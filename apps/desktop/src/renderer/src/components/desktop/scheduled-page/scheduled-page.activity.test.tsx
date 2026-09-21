// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createActivityState } from "@renderer/stores/desktop-session/activity-state"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopScheduledActivity } from "@shared/activity-types"
import { ScheduledPage } from "./scheduled-page"

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedReducedMotion: true }),
}))
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  },
}))
vi.mock("@renderer/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("./scheduled-header", () => ({ ScheduledHeader: () => <div>Scheduled</div> }))
vi.mock("./task-row", () => ({
  TaskRow: ({
    task,
    running,
    onSelect,
    onRunNow,
  }: {
    task: { id: string; runCount?: number }
    running: boolean
    onSelect: () => void
    onRunNow: () => void
  }) => (
    <>
      <button data-running={running} data-run-count={task.runCount ?? 0} onClick={onSelect}>
        {task.id}
      </button>
      <button data-run-now={task.id} onClick={onRunNow}>
        Run {task.id}
      </button>
    </>
  ),
}))
vi.mock("./scheduled-detail", () => ({
  DetailPanel: ({ runs }: { runs: Array<{ id: string; status: string }> }) => (
    <div>{runs.map((run) => `${run.id}:${run.status}`).join(",")}</div>
  ),
}))
vi.mock("./scheduled-task-editor", () => ({ ScheduledTaskEditor: () => null }))

describe("Scheduled detail read semantics", () => {
  let root: Root
  let container: HTMLDivElement
  let tasks = ["a", "b"].map((id) => ({
    id,
    name: id,
    prompt: id,
    projectPaths: [],
    status: "active",
    runCount: 0,
  }))
  let runs = ["a", "b"].map((taskId) => ({
    id: `run-${taskId}`,
    taskId,
    status: "succeeded",
    unread: true,
    sessionId: undefined,
  }))

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    tasks = ["a", "b"].map((id) => ({
      id,
      name: id,
      prompt: id,
      projectPaths: [],
      status: "active",
      runCount: 0,
    }))
    runs = ["a", "b"].map((taskId) => ({
      id: `run-${taskId}`,
      taskId,
      status: "succeeded",
      unread: true,
      sessionId: undefined,
    }))
    useDesktopSessionStore.setState({
      activity: createActivityState(),
      selectedScheduledTaskId: null,
    })
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        schedules: {
          status: vi.fn(async () => ({ unread: runs.filter((run) => run.unread).length })),
          list: vi.fn(async () => tasks.map((task) => ({ ...task }))),
          runNow: vi.fn(async () => undefined),
          listRuns: vi.fn(async (options: { taskId?: string; unread?: boolean; limit?: number }) =>
            runs
              .filter(
                (run) =>
                  (!options?.taskId || run.taskId === options.taskId) &&
                  (options?.unread === undefined || run.unread === options.unread)
              )
              .slice(0, options?.limit ?? 50)
          ),
          setRunUnread: vi.fn(async (id: string, unread: boolean) => {
            runs.find((run) => run.id === id)!.unread = unread
          }),
        },
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("opening the list does not clear runs; opening task a clears only a", async () => {
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(container.querySelector("button")?.textContent).toBe("a"))
    expect(runs.map((run) => run.unread)).toEqual([true, true])
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(runs.map((run) => run.unread)).toEqual([false, true]))
    expect(useDesktopSessionStore.getState().selectedScheduledTaskId).toBe("a")
  })

  it("clears task a's unread results beyond the 30 visible details", async () => {
    runs = [
      ...Array.from({ length: 32 }, (_, index) => ({
        id: `a-${index}`,
        taskId: "a",
        status: "succeeded",
        unread: true,
        sessionId: undefined,
      })),
      { id: "b-0", taskId: "b", status: "succeeded", unread: true, sessionId: undefined },
    ]
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(runs.filter((run) => run.taskId === "a" && run.unread)).toHaveLength(0)
    )
    expect(runs.find((run) => run.id === "b-0")?.unread).toBe(true)
  })

  it("shows a long-running task even when later runs push it out of the latest 50", async () => {
    runs = [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `b-${index}`,
        taskId: "b",
        status: "succeeded",
        unread: false,
        sessionId: undefined,
      })),
      { id: "a-running", taskId: "a", status: "running", unread: false, sessionId: undefined },
    ]
    const runningRun: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 1,
      updatedAt: 1,
      executionState: "running",
      attentionState: "read",
      run: {
        id: "a-running",
        taskId: "a",
        cause: "scheduled",
        status: "running",
        scheduledFor: 1,
        unread: false,
        createdAt: 1,
        updatedAt: 1,
      },
    }
    useDesktopSessionStore.setState({
      activity: { ...createActivityState(), scheduledRuns: { "a-running": runningRun } },
    })
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(container.querySelector("button")?.textContent).toBe("a"))
    expect(container.querySelector('button[data-running="true"]')?.textContent).toBe("a")
  })

  it("does not reload the full task list for read-only run events", async () => {
    const initialRun: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 1,
      updatedAt: 1,
      executionState: "completed",
      attentionState: "unread",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "succeeded",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 1,
      },
    }
    useDesktopSessionStore.setState({
      activity: { ...createActivityState(), scheduledRuns: { "run-a": initialRun } },
    })
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(container.querySelector("button")?.textContent).toBe("a"))
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    const list = window.desktop.schedules.list as ReturnType<typeof vi.fn>
    const status = window.desktop.schedules.status as ReturnType<typeof vi.fn>
    const listRuns = window.desktop.schedules.listRuns as ReturnType<typeof vi.fn>
    const beforeList = list.mock.calls.length
    const beforeStatus = status.mock.calls.length
    const beforeListRuns = listRuns.mock.calls.length
    for (let seq = 1; seq <= 3; seq++) {
      const run: DesktopScheduledActivity = {
        taskId: "a",
        activitySeq: seq,
        updatedAt: seq,
        executionState: "completed",
        attentionState: "read",
        run: {
          id: "run-a",
          taskId: "a",
          cause: "scheduled",
          status: "succeeded",
          scheduledFor: 1,
          unread: false,
          createdAt: 1,
          updatedAt: seq,
        },
      }
      await act(async () => {
        useDesktopSessionStore.setState((state) => ({
          activity: {
            ...state.activity,
            scheduledRuns: { ...state.activity.scheduledRuns, "run-a": run },
          },
        }))
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      })
    }
    expect(list.mock.calls).toHaveLength(beforeList)
    expect(status.mock.calls).toHaveLength(beforeStatus)
    expect(listRuns.mock.calls).toHaveLength(beforeListRuns)
  })

  it("refreshes selected detail and task metadata without status polling", async () => {
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(container.textContent).toContain("run-a:succeeded"))
    const list = window.desktop.schedules.list as ReturnType<typeof vi.fn>
    const status = window.desktop.schedules.status as ReturnType<typeof vi.fn>
    const beforeList = list.mock.calls.length
    const beforeStatus = status.mock.calls.length
    runs.find((run) => run.id === "run-a")!.status = "failed"
    const changed: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 3,
      updatedAt: 3,
      executionState: "failed",
      attentionState: "read",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "failed",
        scheduledFor: 1,
        unread: false,
        createdAt: 1,
        updatedAt: 3,
      },
    }
    await act(async () => {
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          scheduledRuns: { ...state.activity.scheduledRuns, "run-a": changed },
        },
      }))
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(container.textContent).toContain("run-a:failed"))
    expect(list.mock.calls).toHaveLength(beforeList + 1)
    expect(status.mock.calls).toHaveLength(beforeStatus)
  })

  it("refreshes task metadata when a run reaches a new status", async () => {
    const running: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 1,
      updatedAt: 1,
      executionState: "running",
      attentionState: "read",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "running",
        scheduledFor: 1,
        unread: false,
        createdAt: 1,
        updatedAt: 1,
      },
    }
    useDesktopSessionStore.setState({
      activity: { ...createActivityState(), scheduledRuns: { "run-a": running } },
    })
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="0"]')).not.toBeNull()
    )
    tasks[0]!.runCount = 1
    const completed: DesktopScheduledActivity = {
      ...running,
      activitySeq: 2,
      updatedAt: 2,
      executionState: "completed",
      attentionState: "unread",
      run: { ...running.run, status: "succeeded", unread: true, updatedAt: 2 },
    }
    await act(async () => {
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          scheduledRuns: { ...state.activity.scheduledRuns, "run-a": completed },
        },
      }))
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="1"]')?.textContent).toBe("a")
    )
  })

  it("retries a task-list update after a transient event-driven request failure", async () => {
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="0"]')).not.toBeNull()
    )
    tasks[0]!.runCount = 1
    const list = window.desktop.schedules.list as ReturnType<typeof vi.fn>
    list.mockRejectedValueOnce(new Error("temporary list error"))
    const run: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 2,
      updatedAt: 2,
      executionState: "completed",
      attentionState: "unread",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "succeeded",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 2,
      },
    }
    await act(async () => {
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          scheduledRuns: { ...state.activity.scheduledRuns, "run-a": run },
        },
      }))
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      await vi.waitFor(() => expect(list.mock.calls).toHaveLength(3))
      await Promise.resolve()
    })
    expect(container.querySelector('button[data-run-count="1"]')?.textContent).toBe("a")
  })

  it("does not let an older manual refresh overwrite a newer event refresh", async () => {
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="0"]')).not.toBeNull()
    )
    const list = window.desktop.schedules.list as ReturnType<typeof vi.fn>
    let resolveOld!: (rows: typeof tasks) => void
    const oldList = new Promise<typeof tasks>((resolve) => {
      resolveOld = resolve
    })
    list.mockImplementationOnce(() => oldList)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-run-now="a"]')!.click()
    })
    await vi.waitFor(() => expect(list.mock.calls).toHaveLength(2))
    tasks[0]!.runCount = 1
    const run: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 2,
      updatedAt: 2,
      executionState: "completed",
      attentionState: "unread",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "succeeded",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 2,
      },
    }
    await act(async () => {
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          scheduledRuns: { ...state.activity.scheduledRuns, "run-a": run },
        },
      }))
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      await vi.waitFor(() => expect(list.mock.calls).toHaveLength(3))
      await Promise.resolve()
    })
    expect(container.querySelector('button[data-run-count="1"]')?.textContent).toBe("a")
    await act(async () => {
      resolveOld([{ ...tasks[0]!, runCount: 0 }, tasks[1]!])
      await Promise.resolve()
    })
    expect(container.querySelector('button[data-run-count="1"]')?.textContent).toBe("a")
  })

  it("does not apply an old response while a newer event list request is pending", async () => {
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="0"]')).not.toBeNull()
    )
    const list = window.desktop.schedules.list as ReturnType<typeof vi.fn>
    let resolveOld!: (rows: typeof tasks) => void
    let resolveNew!: (rows: typeof tasks) => void
    list.mockImplementationOnce(
      () =>
        new Promise<typeof tasks>((resolve) => {
          resolveOld = resolve
        })
    )
    list.mockImplementationOnce(
      () =>
        new Promise<typeof tasks>((resolve) => {
          resolveNew = resolve
        })
    )
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-run-now="a"]')!.click()
    })
    await vi.waitFor(() => expect(list.mock.calls).toHaveLength(2))
    tasks[0]!.runCount = 1
    const run: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 2,
      updatedAt: 2,
      executionState: "completed",
      attentionState: "unread",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "succeeded",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 2,
      },
    }
    await act(async () => {
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          scheduledRuns: { ...state.activity.scheduledRuns, "run-a": run },
        },
      }))
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(list.mock.calls).toHaveLength(3))
    await act(async () => {
      resolveOld([])
      await Promise.resolve()
    })
    expect(container.querySelector('button[data-run-count="0"]')?.textContent).toBe("a")
    await act(async () => {
      resolveNew(tasks.map((task) => ({ ...task })))
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="1"]')?.textContent).toBe("a")
    )
  })

  it("resumes event-list retries when a manual refresh also fails during backoff", async () => {
    await act(async () => {
      root.render(
        <ScheduledPage
          onStartConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onSessionListChanged={vi.fn()}
        />
      )
    })
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-run-count="0"]')).not.toBeNull()
    )
    const list = window.desktop.schedules.list as ReturnType<typeof vi.fn>
    list.mockRejectedValueOnce(new Error("event list failed"))
    list.mockRejectedValueOnce(new Error("manual list failed"))
    tasks[0]!.runCount = 1
    const run: DesktopScheduledActivity = {
      taskId: "a",
      activitySeq: 2,
      updatedAt: 2,
      executionState: "completed",
      attentionState: "unread",
      run: {
        id: "run-a",
        taskId: "a",
        cause: "scheduled",
        status: "succeeded",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 2,
      },
    }
    await act(async () => {
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          scheduledRuns: { ...state.activity.scheduledRuns, "run-a": run },
        },
      }))
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => {
      await vi.waitFor(() => expect(list.mock.calls).toHaveLength(2))
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-run-now="a"]')!.click()
    })
    await act(async () => {
      await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(3))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(4))
      await Promise.resolve()
    })
    expect(container.querySelector('button[data-run-count="1"]')?.textContent).toBe("a")
  })
})
