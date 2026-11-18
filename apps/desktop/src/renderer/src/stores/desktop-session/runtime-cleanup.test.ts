import { describe, expect, it } from "vitest"

import { createEmptySessionRuntime } from "./operation-state"
import { releaseAcknowledgedRuntime } from "./session-view-state"

describe("desktop session runtime cleanup", () => {
  it("releases acknowledged overlays while keeping pending and failed state for an inactive session", () => {
    const runtime = createEmptySessionRuntime()
    runtime.operations = {
      acknowledged: {
        id: "acknowledged",
        kind: "send-prompt",
        phase: "acknowledged",
        sessionId: "s1",
        startedAt: 1,
      },
      pending: {
        id: "pending",
        kind: "send-prompt",
        phase: "pending",
        sessionId: "s1",
        startedAt: 1,
      },
      failed: {
        id: "failed",
        kind: "reply-permission",
        phase: "failed",
        sessionId: "s1",
        target: "permission-1",
        startedAt: 1,
        finishedAt: 2,
        error: "授权回复失败",
      },
    }
    runtime.pendingPromptSubmissions = {
      accepted: {
        id: "accepted",
        sessionId: "s1",
        items: [{ type: "text" as const, text: "accepted" }],
        content: "accepted",
        attachments: [],
        createdAt: 1,
        phase: "accepted",
        placement: "transcript",
      },
      "direct-follow-up": {
        id: "direct-follow-up",
        sessionId: "s1",
        items: [{ type: "text", text: "follow-up" }],
        content: "follow-up",
        attachments: [],
        createdAt: 1,
        phase: "accepted",
        delivery: "steer",
        expectedActiveRunId: "active-run",
        placement: "transcript",
      },
      submitting: {
        id: "submitting",
        sessionId: "s1",
        items: [{ type: "text" as const, text: "pending" }],
        content: "pending",
        attachments: [],
        createdAt: 2,
        phase: "submitting",
        placement: "queue",
      },
      failed: {
        id: "failed",
        sessionId: "s1",
        items: [{ type: "text" as const, text: "failed" }],
        content: "failed",
        attachments: [],
        createdAt: 3,
        phase: "failed",
        placement: "queue",
        error: "发送失败",
      },
    }
    runtime.queuedPromptActions = {
      acknowledged: {
        sessionId: "s1",
        inputId: "input-1",
        runId: "run-1",
        kind: "promote",
        phase: "acknowledged",
      },
      pending: {
        sessionId: "s1",
        inputId: "input-2",
        runId: "run-2",
        kind: "cancel",
        phase: "pending",
      },
      failed: {
        sessionId: "s1",
        inputId: "input-3",
        runId: "run-3",
        kind: "promote",
        phase: "failed",
        error: "调整失败",
      },
    }

    const released = releaseAcknowledgedRuntime(runtime)

    expect(released.operations).toEqual({
      pending: runtime.operations.pending,
      failed: runtime.operations.failed,
    })
    expect(released.pendingPromptSubmissions).toEqual({
      "direct-follow-up": runtime.pendingPromptSubmissions["direct-follow-up"],
      submitting: runtime.pendingPromptSubmissions.submitting,
      failed: runtime.pendingPromptSubmissions.failed,
    })
    expect(released.queuedPromptActions).toEqual({
      pending: runtime.queuedPromptActions.pending,
      failed: runtime.queuedPromptActions.failed,
    })
  })
})
