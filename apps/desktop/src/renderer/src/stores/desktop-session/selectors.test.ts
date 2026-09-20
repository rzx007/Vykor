import { describe, expect, it } from "vitest"

import { createEmptySessionRuntime } from "./operation-state"
import {
  selectActiveSessionOpening,
  selectActiveSessionPermissionReplies,
  selectActiveWorkspaceProject,
  selectCommandCatalogCwd,
  selectImSessionGroups,
  selectPermissionReplyError,
  selectPermissionReplyPending,
  selectActiveSessionPromptSubmissions,
  selectActiveSessionSending,
  selectAppOperationError,
  selectNewConversationError,
  selectNewConversationSending,
  selectProjectOperationError,
  selectSessionComposerError,
  selectSessionSending,
} from "./selectors"
import type { DesktopSessionRecord } from "@shared/session-types"
import type { DesktopOperationKind, DesktopSessionState } from "./types"

function stateWithPendingOperation(
  sessionId: string,
  kind: DesktopOperationKind
): DesktopSessionState {
  const runtime = createEmptySessionRuntime()
  runtime.operations["operation-1"] = {
    id: "operation-1",
    kind,
    phase: "pending",
    sessionId,
    startedAt: 1,
  }
  return stateWith({ sessionRuntimes: { [sessionId]: runtime } })
}

function stateWithNewConversationOperation(kind: DesktopOperationKind): DesktopSessionState {
  const newConversationRuntime = createEmptySessionRuntime()
  newConversationRuntime.operations["operation-new"] = {
    id: "operation-new",
    kind,
    phase: "pending",
    sessionId: null,
    startedAt: 1,
  }
  return stateWith({ newConversationRuntime })
}

function stateWith(overrides: Partial<DesktopSessionState>): DesktopSessionState {
  return {
    activeSessionId: null,
    newConversationRuntime: createEmptySessionRuntime(),
    sessionRuntimes: {},
    appOperations: {},
    projectOperations: {},
    ...overrides,
  } as DesktopSessionState
}

function channelSession(overrides: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: "s1",
    projectId: "p1",
    cwd: "/data/channels/feishu/oc_1-abc",
    title: "会话",
    model: "m",
    status: "idle",
    metadata: { externalConversation: { connector: "feishu" } },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("selectImSessionGroups", () => {
  it("groups only channel sessions by platform with labels", () => {
    const groups = selectImSessionGroups(
      stateWith({
        sessions: [
          channelSession({ id: "a", metadata: { externalConversation: { connector: "feishu" } } }),
          channelSession({
            id: "b",
            updatedAt: 5,
            metadata: { externalConversation: { connector: "slack" } },
          }),
          channelSession({ id: "c", metadata: { source: "channel" } }),
          channelSession({ id: "ordinary", metadata: {}, cwd: "/work/alpha" }),
        ],
      }) as DesktopSessionState
    )
    // ordinary 会话（无渠道 metadata）不入选。
    const ids = groups.flatMap((group) => group.sessions.map((session) => session.id))
    expect(ids).not.toContain("ordinary")
    expect(groups.find((group) => group.connector === "feishu")?.label).toBe("飞书")
    expect(groups.find((group) => group.connector === "slack")?.label).toBe("其他平台")
    expect(groups.find((group) => group.connector === "other")?.label).toBe("其他平台")
  })

  it("sorts pinned first, then updatedAt, and orders groups by their latest session", () => {
    const groups = selectImSessionGroups(
      stateWith({
        sessions: [
          channelSession({ id: "old", updatedAt: 1 }),
          channelSession({ id: "new", updatedAt: 9 }),
          channelSession({
            id: "pinned",
            updatedAt: 2,
            metadata: { externalConversation: { connector: "feishu" }, desktop: { pinnedAt: 5 } },
          }),
          channelSession({
            id: "slack-new",
            updatedAt: 20,
            metadata: { externalConversation: { connector: "slack" } },
          }),
        ],
      }) as DesktopSessionState
    )
    const feishu = groups.find((group) => group.connector === "feishu")!
    expect(feishu.sessions.map((session) => session.id)).toEqual(["pinned", "new", "old"])
    // slack 组最新 20 > feishu 组最新 9。
    expect(groups[0]?.connector).toBe("slack")
  })
})

describe("desktop session selectors", () => {
  it("provides the active outside-project workspace to right-panel tools", () => {
    const session = {
      id: "outside-session",
      projectId: "managed-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-09-01\\x1",
      title: "项目外会话",
      model: "test-model",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    }
    const state = stateWith({
      activeSessionId: session.id,
      selectedProject: null,
      sessions: [session],
      sessionView: null,
    })
    const workspace = selectActiveWorkspaceProject(state)
    expect(workspace).toEqual({
      id: "managed-workspace-project",
      name: "x1",
      path: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-09-01\\x1",
      lastOpenedAt: 2,
      available: true,
    })
    expect(selectActiveWorkspaceProject(state)).toBe(workspace)
  })

  it("provides the outside-project draft workspace before a session exists", () => {
    const state = stateWith({
      workspaceMode: "outside_project",
      selectedProject: null,
      outsideProjectWorkspaceRoot: "C:\\Users\\tester\\Documents\\OpenHarness",
    })

    expect(selectActiveWorkspaceProject(state)).toEqual({
      id: "outside-project-draft",
      name: "OpenHarness",
      path: "C:\\Users\\tester\\Documents\\OpenHarness",
      lastOpenedAt: 0,
      available: true,
    })
    expect(selectActiveWorkspaceProject(state)).toBe(selectActiveWorkspaceProject(state))
    expect(selectCommandCatalogCwd(state)).toBe("C:\\Users\\tester\\Documents\\OpenHarness")
  })

  it("uses session cwd for slash commands when a conversation is open", () => {
    const session = {
      id: "session-a",
      cwd: "D:\\repo",
      title: "test",
      model: "test-model",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    }
    const state = stateWith({
      activeSessionId: session.id,
      selectedProject: {
        id: "project-a",
        name: "repo",
        path: "D:\\other-repo",
        lastOpenedAt: 1,
        available: true,
      },
      sessionView: {
        cursor: 0,
        syncStatus: "connected" as const,
        session,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        tasks: [],
        permissions: [],
      },
    })

    expect(selectCommandCatalogCwd(state)).toBe("D:\\repo")
  })

  it("selects sending only from the requested session", () => {
    const state = stateWithPendingOperation("session-a", "send-prompt")

    expect(selectSessionSending(state, "session-a")).toBe(true)
    expect(selectSessionSending(state, "session-b")).toBe(false)
  })

  it("selects new-conversation sending independently", () => {
    const state = stateWithNewConversationOperation("create-session")

    expect(selectNewConversationSending(state)).toBe(true)
    expect(selectActiveSessionSending({ ...state, activeSessionId: "session-a" })).toBe(false)
  })

  it("keeps a background session error out of the active composer", () => {
    const state = stateWith({
      activeSessionId: "session-b",
      sessionRuntimes: {
        "session-a": {
          ...createEmptySessionRuntime(),
          operations: {
            "send-a": {
              id: "send-a",
              kind: "edit-prompt",
              phase: "failed",
              sessionId: "session-a",
              startedAt: 1,
              finishedAt: 2,
              error: "session A failed",
            },
          },
        },
        "session-b": createEmptySessionRuntime(),
      },
    })

    expect(selectSessionComposerError(state, "session-a")).toBe("session A failed")
    expect(selectSessionComposerError(state, "session-b")).toBeNull()
  })

  it("leaves a failed prompt submission to its inline owner", () => {
    const state = stateWith({
      sessionRuntimes: {
        "session-a": {
          ...createEmptySessionRuntime(),
          operations: {
            "send-a": {
              id: "send-a",
              kind: "send-prompt",
              phase: "failed",
              sessionId: "session-a",
              startedAt: 1,
              finishedAt: 2,
              error: "operation error",
            },
          },
          pendingPromptSubmissions: {
            "send-a": {
              id: "send-a",
              sessionId: "session-a",
              items: [{ type: "text" as const, text: "message" }],
              content: "message",
              attachments: [],
              createdAt: 1,
              phase: "failed",
              placement: "transcript",
              error: "submission error",
            },
          },
        },
      },
    })

    expect(selectSessionComposerError(state, "session-a")).toBeNull()
  })

  it("selects pending and failed replies for one permission only", () => {
    const state = stateWith({
      sessionRuntimes: {
        "session-a": {
          ...createEmptySessionRuntime(),
          operations: {
            "session-a:permission-pending": {
              id: "session-a:permission-pending",
              kind: "reply-permission",
              phase: "pending",
              sessionId: "session-a",
              target: "permission-pending",
              startedAt: 1,
            },
            "session-a:permission-failed": {
              id: "session-a:permission-failed",
              kind: "reply-permission",
              phase: "failed",
              sessionId: "session-a",
              target: "permission-failed",
              startedAt: 1,
              finishedAt: 2,
              error: "授权回复失败",
            },
          },
        },
      },
    })

    expect(selectPermissionReplyPending(state, "session-a", "permission-pending")).toBe(true)
    expect(selectPermissionReplyPending(state, "session-a", "permission-failed")).toBe(false)
    expect(selectPermissionReplyError(state, "session-a", "permission-failed")).toBe("授权回复失败")
    expect(selectPermissionReplyError(state, "session-a", "permission-pending")).toBeNull()
    expect(selectActiveSessionPermissionReplies(state)).toBe(
      selectActiveSessionPermissionReplies(state)
    )
  })

  it.each(["open-session", "edit-prompt", "interrupt-run"] as const)(
    "selects a failed %s operation for its active session owner",
    (kind) => {
      const state = stateWith({
        activeSessionId: "session-a",
        sessionRuntimes: {
          "session-a": {
            ...createEmptySessionRuntime(),
            operations: {
              operation: {
                id: "operation",
                kind,
                phase: "failed",
                sessionId: "session-a",
                startedAt: 1,
                finishedAt: 2,
                error: `${kind} failed`,
              },
            },
          },
        },
      })

      expect(selectSessionComposerError(state, "session-a")).toBe(`${kind} failed`)
    }
  )

  it("selects opening, prompt submissions, and scope-specific errors", () => {
    const state = stateWith({
      activeSessionId: "session-a",
      newConversationRuntime: {
        ...createEmptySessionRuntime(),
        operations: {
          "create-new": {
            id: "create-new",
            kind: "create-session",
            phase: "failed",
            sessionId: null,
            startedAt: 1,
            finishedAt: 2,
            error: "cannot create",
          },
        },
      },
      sessionRuntimes: {
        "session-a": {
          ...createEmptySessionRuntime(),
          operations: {
            "open-a": {
              id: "open-a",
              kind: "open-session",
              phase: "pending",
              sessionId: "session-a",
              startedAt: 1,
            },
          },
          pendingPromptSubmissions: {
            "prompt-a": {
              id: "prompt-a",
              sessionId: "session-a",
              items: [{ type: "text" as const, text: "still local" }],
              content: "still local",
              attachments: [],
              createdAt: 1,
              phase: "accepted",
              placement: "transcript",
            },
          },
        },
      },
      projectOperations: {
        "project-a": {
          "inspect-a": {
            id: "inspect-a",
            kind: "project-action",
            phase: "failed",
            sessionId: null,
            projectId: "project-a",
            startedAt: 1,
            finishedAt: 2,
            error: "cannot inspect project",
          },
        },
      },
    })

    expect(selectActiveSessionOpening(state)).toBe(true)
    expect(selectActiveSessionPromptSubmissions(state)).toBe(
      state.sessionRuntimes["session-a"]!.pendingPromptSubmissions
    )
    expect(selectNewConversationError(state)).toBe("cannot create")
    expect(selectProjectOperationError(state, "project-a")).toBe("cannot inspect project")
  })

  it("selects bootstrap and project-picker errors for the app owner", () => {
    const state = stateWith({
      appOperations: {
        initialize: {
          id: "initialize",
          kind: "project-action",
          phase: "failed",
          sessionId: null,
          target: "initialize",
          startedAt: 1,
          finishedAt: 2,
          error: "bootstrap failed",
        },
        choose: {
          id: "choose",
          kind: "project-action",
          phase: "failed",
          sessionId: null,
          target: "choose-project",
          startedAt: 3,
          finishedAt: 4,
          error: "project picker failed",
        },
        refresh: {
          id: "refresh",
          kind: "project-action",
          phase: "failed",
          sessionId: null,
          target: "refresh-bootstrap",
          startedAt: 5,
          finishedAt: 6,
          error: "settings refresh failed",
        },
      },
    })

    expect(selectAppOperationError(state)).toBe("project picker failed")
  })
})
