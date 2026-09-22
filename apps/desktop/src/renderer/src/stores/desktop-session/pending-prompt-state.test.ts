import { describe, expect, it } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import { createEmptySessionRuntime } from "./operation-state"
import {
  classifyPromptPlacement,
  queuedPromptActionConfirmed,
  queuedPromptActionKey,
  reconcilePendingPromptSubmissions,
  reconcileQueuedPromptActions,
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./pending-prompt-state"

function emptySessionView(sessionId: string): DesktopSessionView {
  return {
    cursor: 0,
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

describe("desktop pending prompt state", () => {
  it("classifies a second unconfirmed prompt as queued", () => {
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

    expect(classifyPromptPlacement(null, runtime, "s1")).toBe("queue")
  })

  it("queues a prompt when the authoritative view has a pending run", () => {
    const view = emptySessionView("s1")
    view.runs.push({
      id: "run-1",
      sessionId: "s1",
      status: "pending",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    })

    expect(classifyPromptPlacement(view, createEmptySessionRuntime(), "s1")).toBe("queue")
  })

  it("does not count a failed submission as in flight", () => {
    const runtime = createEmptySessionRuntime()
    runtime.pendingPromptSubmissions["input-1"] = {
      id: "input-1",
      sessionId: "s1",
      items: [{ type: "text" as const, text: "failed" }],
      content: "failed",
      attachments: [],
      createdAt: 1,
      phase: "failed",
      placement: "transcript",
      error: "request failed",
    }

    expect(classifyPromptPlacement(null, runtime, "s1")).toBe("transcript")
  })

  it("updates, removes, and reconciles only submissions confirmed by the matching view", () => {
    const submissions = {
      "input-1": {
        id: "input-1",
        sessionId: "s1",
        items: [{ type: "text" as const, text: "first" }],
        content: "first",
        attachments: [],
        createdAt: 1,
        phase: "submitting" as const,
        placement: "transcript" as const,
      },
      "input-2": {
        id: "input-2",
        sessionId: "s2",
        items: [{ type: "text" as const, text: "background" }],
        content: "background",
        attachments: [],
        createdAt: 2,
        phase: "accepted" as const,
        placement: "queue" as const,
      },
    }
    const updated = updatePendingPromptSubmission(submissions, "input-1", (submission) => ({
      ...submission,
      phase: "accepted",
    }))
    const view = emptySessionView("s1")
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

    expect(updated["input-1"]?.phase).toBe("accepted")
    expect(removePendingPromptSubmission(updated, "input-1")).not.toHaveProperty("input-1")
    expect(reconcilePendingPromptSubmissions(updated, view)).toEqual({
      "input-1": updated["input-1"],
      "input-2": submissions["input-2"],
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
    expect(reconcilePendingPromptSubmissions(updated, view)).toEqual({
      "input-1": updated["input-1"],
      "input-2": submissions["input-2"],
    })

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
    expect(reconcilePendingPromptSubmissions(updated, view)).toEqual({
      "input-2": submissions["input-2"],
    })
  })

  it("reconciles queued actions after their run is no longer pending", () => {
    const action = {
      sessionId: "s1",
      inputId: "input-1",
      runId: "run-1",
      kind: "promote" as const,
      phase: "acknowledged" as const,
    }
    const view = emptySessionView("s1")
    view.runs.push({
      id: "run-1",
      sessionId: "s1",
      status: "interrupted",
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    })

    expect(queuedPromptActionKey("s1", "run-1")).toBe("s1:run-1")
    expect(queuedPromptActionConfirmed(view, action)).toBe(true)
    expect(reconcileQueuedPromptActions({ "s1:run-1": action }, view)).toEqual({})
  })

  it("keeps a queued action when the incoming view does not include its run", () => {
    const action = {
      sessionId: "s1",
      inputId: "input-1",
      runId: "run-missing",
      kind: "cancel" as const,
      phase: "pending" as const,
    }

    expect(
      reconcileQueuedPromptActions({ "s1:run-missing": action }, emptySessionView("s1"))
    ).toEqual({ "s1:run-missing": action })
  })
})
