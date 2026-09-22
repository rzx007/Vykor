import { describe, expect, it } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import { createEmptySessionRuntime } from "./operation-state"
import { acceptActiveSessionView, reconcileRuntimeWithView } from "./session-view-state"

function emptySessionView(sessionId: string, cursor = 0): DesktopSessionView {
  return {
    cursor,
    syncStatus: "connected",
    session: {
      id: sessionId,
      cwd: "D:\\repo",
      title: "test",
      model: "test-model",
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

describe("desktop session view state", () => {
  it("does not replace a newer active view with an older cursor", () => {
    const current = emptySessionView("s1", 5)
    const incoming = emptySessionView("s1", 4)

    expect(acceptActiveSessionView("s1", current, incoming)).toBe(current)
  })

  it("ignores a view for a background session", () => {
    expect(
      acceptActiveSessionView("s2", emptySessionView("s2", 2), emptySessionView("s1", 3))
    ).toEqual(emptySessionView("s2", 2))
  })

  it("accepts an equal or newer view for the active session", () => {
    const current = emptySessionView("s1", 2)
    const incoming = emptySessionView("s1", 2)

    expect(acceptActiveSessionView("s1", current, incoming)).toBe(incoming)
  })

  it("reconciles only matching runtime entities that the view confirms", () => {
    const runtime = createEmptySessionRuntime()
    runtime.pendingPromptSubmissions["input-1"] = {
      id: "input-1",
      sessionId: "s1",
      items: [{ type: "text" as const, text: "first" }],
      content: "first",
      attachments: [],
      createdAt: 1,
      phase: "accepted",
      placement: "transcript",
    }
    runtime.pendingPromptSubmissions["input-2"] = {
      id: "input-2",
      sessionId: "s2",
      items: [{ type: "text" as const, text: "background" }],
      content: "background",
      attachments: [],
      createdAt: 2,
      phase: "accepted",
      placement: "queue",
    }
    runtime.queuedPromptActions["s1:run-1"] = {
      sessionId: "s1",
      inputId: "input-1",
      runId: "run-1",
      kind: "promote",
      phase: "acknowledged",
    }
    runtime.queuedPromptActions["s2:run-1"] = {
      sessionId: "s2",
      inputId: "input-2",
      runId: "run-1",
      kind: "cancel",
      phase: "acknowledged",
    }
    runtime.operations["input-1"] = {
      id: "input-1",
      kind: "send-prompt",
      phase: "acknowledged",
      sessionId: "s1",
      startedAt: 1,
    }
    runtime.operations["input-2"] = {
      id: "input-2",
      kind: "send-prompt",
      phase: "acknowledged",
      sessionId: "s2",
      startedAt: 2,
    }
    const view = emptySessionView("s1", 3)
    view.inputs.push({
      id: "input-1",
      sessionId: "s1",
      seq: 1,
      delivery: "steer",
      items: [{ type: "text" as const, text: "first" }],
      content: "first",
      attachments: [],
      metadata: {},
      createdAt: 1,
    })
    view.runs.push({
      id: "run-1",
      sessionId: "s1",
      status: "completed",
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    })

    expect(reconcileRuntimeWithView(runtime, view)).toMatchObject({
      pendingPromptSubmissions: {
        "input-1": runtime.pendingPromptSubmissions["input-1"],
        "input-2": runtime.pendingPromptSubmissions["input-2"],
      },
      queuedPromptActions: { "s2:run-1": runtime.queuedPromptActions["s2:run-1"] },
      operations: { "input-2": runtime.operations["input-2"] },
    })

    view.messages.push({
      id: "message-1",
      sessionId: "s1",
      seq: 1,
      role: "user",
      inputId: "input-1",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    })
    expect(reconcileRuntimeWithView(runtime, view).pendingPromptSubmissions).toHaveProperty("input-1")
    view.parts.push({
      id: "part-1",
      sessionId: "s1",
      messageId: "message-1",
      seq: 1,
      type: "text",
      status: "completed",
      text: "first",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    })

    expect(reconcileRuntimeWithView(runtime, view).pendingPromptSubmissions).toEqual({
      "input-2": runtime.pendingPromptSubmissions["input-2"],
    })
  })
})
