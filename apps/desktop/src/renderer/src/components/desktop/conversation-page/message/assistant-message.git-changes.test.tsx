// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  state: { selectedProject: { path: "D:/repo" } } as Record<string, unknown>,
}))
vi.mock("@renderer/stores/desktop-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/stores/desktop-session")>()
  return {
    ...actual,
    useDesktopSessionStore: (selector: (state: unknown) => unknown) => selector(store.state),
  }
})

import { resetGitChangesQueryCacheForTests } from "@renderer/lib/git-changes-query"
import { ChangedFilesSummary } from "./assistant-message"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  store.state = { selectedProject: { path: "D:/repo" } }
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetGitChangesQueryCacheForTests()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

it("shares one git request across changed-file summaries", async () => {
  const changes = vi.fn().mockResolvedValue({
    rootPath: "D:/repo",
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 4,
        deletions: 2,
        binary: false,
      },
    ],
    totalAdditions: 4,
    totalDeletions: 2,
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { changes } },
  })
  const props = {
    files: [{ path: "src/a.ts", additions: 0, deletions: 0, hasStats: false }],
    canOpenReview: true,
    onOpenFile: vi.fn(),
    onOpenReview: vi.fn(),
  }

  await act(async () => {
    root.render(
      <>
        <ChangedFilesSummary {...props} />
        <ChangedFilesSummary {...props} />
      </>
    )
  })

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10))
    await Promise.resolve()
  })

  expect(changes).toHaveBeenCalledTimes(1)
  expect(container.textContent?.match(/\+4/g)).toHaveLength(4)
  expect(container.textContent?.match(/-2/g)).toHaveLength(4)
})

it("queries git stats for an outside-project session instead of clearing them", async () => {
  store.state = {
    selectedProject: null,
    activeSessionId: "session-1",
    sessions: [
      {
        id: "session-1",
        workspaceMode: "outside_project",
        cwd: "D:/repo",
        title: "Outside project",
        model: "gpt-5",
        status: "idle",
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    sessionView: null,
  }
  const changes = vi.fn().mockResolvedValue({
    rootPath: "D:/repo",
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 4,
        deletions: 2,
        binary: false,
      },
    ],
    totalAdditions: 4,
    totalDeletions: 2,
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { changes } },
  })

  await act(async () => {
    root.render(
      <ChangedFilesSummary
        files={[{ path: "src/a.ts", additions: 0, deletions: 0, hasStats: false }]}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
      />
    )
  })

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10))
    await Promise.resolve()
  })

  expect(changes).toHaveBeenCalledWith({ rootPath: "D:/repo", scope: "uncommitted" })
  expect(container.textContent).toContain("+4")
  expect(container.textContent).toContain("-2")
})
