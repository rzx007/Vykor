import { expect, it } from "vitest"

import type { DesktopSessionRun } from "@shared/session-types"
import { reconcilePendingPromptSubmissions } from "../pending-prompt-state"
import { emptySessionView } from "../store-test-fixtures"
import type { PendingPromptSubmission } from "../types"

const pending: PendingPromptSubmission = {
  id: "queued-input",
  sessionId: "chat",
  content: "待处理正文",
  items: [{ type: "text", text: "待处理正文" }],
  attachments: [],
  createdAt: 1,
  phase: "accepted",
  placement: "queue",
}

function viewWithRun(status: DesktopSessionRun["status"]) {
  const view = emptySessionView("chat")
  view.inputs = [
    {
      id: pending.id,
      sessionId: "chat",
      seq: 1,
      delivery: "queue",
      content: pending.content,
      items: pending.items,
      attachments: [],
      metadata: {},
      createdAt: 1,
    },
  ]
  view.runs = [
    {
      id: "queued-run",
      sessionId: "chat",
      inputId: pending.id,
      status,
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    },
  ]
  return view
}

it.each(["interrupted", "completed", "failed"] as const)(
  "removes the local placeholder when its run is %s without a projected message",
  (status) => {
    expect(
      reconcilePendingPromptSubmissions({ [pending.id]: pending }, viewWithRun(status))
    ).toEqual({})
  }
)

it.each(["pending", "running"] as const)(
  "keeps a confirmed placeholder while its run is %s and has no projected message",
  (status) => {
    expect(
      reconcilePendingPromptSubmissions({ [pending.id]: pending }, viewWithRun(status))
    ).toEqual({
      [pending.id]: pending,
    })
  }
)

it("keeps an unconfirmed failed send when only another input has ended", () => {
  const failed: PendingPromptSubmission = {
    ...pending,
    id: "unsent",
    phase: "failed",
    error: "offline",
  }
  expect(reconcilePendingPromptSubmissions({ unsent: failed }, viewWithRun("interrupted"))).toEqual(
    {
      unsent: failed,
    }
  )
})

it("does not clear a different session's local submission", () => {
  const other: PendingPromptSubmission = { ...pending, sessionId: "other" }
  expect(
    reconcilePendingPromptSubmissions({ [other.id]: other }, viewWithRun("interrupted"))
  ).toEqual({
    [other.id]: other,
  })
})
