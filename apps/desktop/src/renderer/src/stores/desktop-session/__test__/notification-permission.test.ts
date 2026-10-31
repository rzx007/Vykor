import { afterEach, expect, it, vi } from "vitest"
import { createActivityState } from "../activity-state"
import { useDesktopSessionStore } from "../store"
import { emptySessionView } from "../store-test-fixtures"

afterEach(() => vi.unstubAllGlobals())

it("carries the originating permission request through native notification delivery", async () => {
  const delivered: unknown[] = []
  vi.stubGlobal("window", {
    desktop: {
      settings: {
        snapshot: async () => ({
          notificationMode: "when_unfocused",
          notificationSounds: { needs_input: "none" },
        }),
      },
      tray: {
        notify: async (notice: unknown) => {
          delivered.push(notice)
        },
      },
    },
  })
  useDesktopSessionStore.setState({
    activity: createActivityState(),
    activeSessionId: null,
    sessionView: null,
    sessions: [],
  })
  const activity = {
    session: emptySessionView("origin-chat").session,
    executionState: "running" as const,
    attentionState: "read" as const,
    activitySeq: 1,
    updatedAt: 1,
  }
  useDesktopSessionStore.getState().applyActivityUpdate({
    cursor: 1,
    delivery: "baseline",
    sessions: [activity],
    scheduled: [],
  })
  useDesktopSessionStore.getState().applyActivityUpdate({
    cursor: 2,
    delivery: "live",
    sessions: [
      { ...activity, executionState: "needs_input", activitySeq: 2, permissionId: "specific-request" },
    ],
    scheduled: [],
  })

  await vi.waitFor(() => expect(delivered).toHaveLength(1))
  expect(delivered[0]).toMatchObject({
    sessionId: "origin-chat",
    permissionId: "specific-request",
    eventStatus: "needs_input",
  })
})
