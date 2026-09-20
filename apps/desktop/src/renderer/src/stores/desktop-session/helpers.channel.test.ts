import { describe, expect, it } from "vitest"

import { isChannelSession, projectFromSession, resolveSessionWorkspace } from "./helpers"
import type { DesktopSessionRecord } from "@shared/session-types"

function session(overrides: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: "s1",
    projectId: "p1",
    cwd: "/data/channels/feishu/oc_1-abc",
    title: "帮我看下这个报错",
    model: "m",
    status: "idle",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("isChannelSession", () => {
  it("detects channel sessions by metadata and excludes forks", () => {
    expect(isChannelSession(session({ metadata: { externalConversation: { connector: "feishu" } } }))).toBe(true)
    expect(isChannelSession(session({ metadata: { source: "channel" } }))).toBe(true)
    expect(isChannelSession(session({ metadata: {} }))).toBe(false)
    expect(
      isChannelSession(
        session({ metadata: { source: "channel", fork: { sourceSessionId: "s0" } } })
      )
    ).toBe(false)
  })
})

describe("resolveSessionWorkspace for channel sessions", () => {
  it("treats channel sessions (including legacy ones without workspaceMode) as outside-project", () => {
    const channel = session({ metadata: { externalConversation: { connector: "feishu" } } })
    expect(resolveSessionWorkspace([], channel)).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
    })
  })
})

describe("projectFromSession display name", () => {
  it("uses the session title for channel sessions", () => {
    const channel = session({ metadata: { source: "channel" } })
    expect(projectFromSession(channel).name).toBe("帮我看下这个报错")
  })

  it("falls back to the directory name for ordinary project sessions", () => {
    const ordinary = session({ cwd: "/work/alpha", metadata: {} })
    expect(projectFromSession(ordinary).name).toBe("alpha")
  })
})
