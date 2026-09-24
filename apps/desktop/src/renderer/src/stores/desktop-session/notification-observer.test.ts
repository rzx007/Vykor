import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  DesktopPermissionRequest,
  DesktopSessionRun,
  DesktopSessionView,
} from "@shared/session-types"
import type { DesktopSettingsSnapshot } from "@shared/settings-types"
import { notifyForSessionViewChange } from "./notification-observer"
import { emptySessionView } from "./store-test-fixtures"

describe("notifyForSessionViewChange", () => {
  const notify = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
  const snapshot = vi.fn<() => Promise<DesktopSettingsSnapshot>>(async () => ({
    workStyle: "practical" as const,
    notificationMode: "when_unfocused" as const,
    agentEnvironment: "native" as const,
    showReasoning: true,
    restartRequired: false,
    defaultOpenerId: null,
    defaultTerminalShellId: null,
  }))

  beforeEach(() => {
    notify.mockClear()
    snapshot.mockClear()
    vi.stubGlobal("window", {
      desktop: {
        settings: { snapshot },
        tray: { notify },
      },
    })
  })

  it("notifies when a running run completes", async () => {
    await notifyForSessionViewChange({
      previous: withRuns(emptySessionView("session-1"), [run("run-1", "running")]),
      next: withRuns(emptySessionView("session-1"), [run("run-1", "completed")]),
    })

    expect(notify).toHaveBeenCalledWith({
      title: "Vykor",
      body: "test 已完成。",
    })
  })

  it("notifies when a running run fails", async () => {
    await notifyForSessionViewChange({
      previous: withRuns(emptySessionView("session-1"), [run("run-1", "running")]),
      next: withRuns(emptySessionView("session-1"), [
        run("run-1", "failed", { error: "model failed" }),
      ]),
    })

    expect(notify).toHaveBeenCalledWith({
      title: "Vykor",
      body: "test 运行失败。",
    })
  })

  it("notifies when a new pending permission appears", async () => {
    await notifyForSessionViewChange({
      previous: emptySessionView("session-1"),
      next: withPermissions(emptySessionView("session-1"), [permission("permission-1")]),
    })

    expect(notify).toHaveBeenCalledWith({
      title: "Vykor 需要处理",
      body: "test 正在等待 Bash 授权。",
    })
  })

  it("does not notify for initial snapshots", async () => {
    await notifyForSessionViewChange({
      previous: null,
      next: withRuns(emptySessionView("session-1"), [run("run-1", "completed")]),
    })

    expect(notify).not.toHaveBeenCalled()
  })

  it("does not notify when notification mode is never", async () => {
    snapshot.mockResolvedValueOnce({
      workStyle: "practical",
      notificationMode: "never",
      agentEnvironment: "native",
      showReasoning: true,
      restartRequired: false,
      defaultOpenerId: null,
      defaultTerminalShellId: null,
    })

    await notifyForSessionViewChange({
      previous: withRuns(emptySessionView("session-1"), [run("run-1", "running")]),
      next: withRuns(emptySessionView("session-1"), [run("run-1", "completed")]),
    })

    expect(notify).not.toHaveBeenCalled()
  })

  it("uses showWhenFocused only for always mode", async () => {
    snapshot.mockResolvedValueOnce({
      workStyle: "practical",
      notificationMode: "always",
      agentEnvironment: "native",
      showReasoning: true,
      restartRequired: false,
      defaultOpenerId: null,
      defaultTerminalShellId: null,
    })

    await notifyForSessionViewChange({
      previous: withRuns(emptySessionView("session-1"), [run("run-1", "running")]),
      next: withRuns(emptySessionView("session-1"), [run("run-1", "completed")]),
    })

    expect(notify).toHaveBeenCalledWith({
      title: "Vykor",
      body: "test 已完成。",
      showWhenFocused: true,
    })
  })
})

function withRuns(view: DesktopSessionView, runs: DesktopSessionRun[]): DesktopSessionView {
  return { ...view, runs }
}

function withPermissions(
  view: DesktopSessionView,
  permissions: DesktopPermissionRequest[]
): DesktopSessionView {
  return { ...view, permissions }
}

function run(
  id: string,
  status: DesktopSessionRun["status"],
  overrides: Partial<DesktopSessionRun> = {}
): DesktopSessionRun {
  return {
    id,
    sessionId: "session-1",
    status,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function permission(
  id: string,
  overrides: Partial<DesktopPermissionRequest> = {}
): DesktopPermissionRequest {
  return {
    id,
    sessionId: "session-1",
    toolName: "Bash",
    payload: {},
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
