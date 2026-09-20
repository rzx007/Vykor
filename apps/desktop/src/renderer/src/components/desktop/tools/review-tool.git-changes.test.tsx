// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ queryGitChanges: vi.fn() }))
const store = vi.hoisted(() => ({
  state: {
    selectedProject: { path: "D:/repo" },
    sessionView: null,
  } as Record<string, unknown>,
}))
vi.mock("@renderer/lib/git-changes-query", () => ({
  queryGitChanges: mocks.queryGitChanges,
}))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))
vi.mock("@renderer/stores/desktop-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/stores/desktop-session")>()
  return {
    ...actual,
    useDesktopSessionStore: (selector: (state: unknown) => unknown) => selector(store.state),
  }
})

import { ReviewTool } from "./review-tool"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.queryGitChanges.mockReset()
  store.state = {
    selectedProject: { path: "D:/repo" },
    sessionView: null,
  }
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
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

it("forces a fresh query from the refresh button and keeps errors visible", async () => {
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo",
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  })
  await act(async () => {
    root.render(<ReviewTool />)
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10))
    await Promise.resolve()
  })
  expect(mocks.queryGitChanges).toHaveBeenNthCalledWith(
    1,
    {
      rootPath: "D:/repo",
      scope: "uncommitted",
    },
    { force: false }
  )

  mocks.queryGitChanges.mockRejectedValueOnce(new Error("refresh failed"))
  const refresh = container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')
  await act(async () => {
    refresh?.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mocks.queryGitChanges).toHaveBeenLastCalledWith(
    {
      rootPath: "D:/repo",
      scope: "uncommitted",
    },
    { force: true }
  )
  expect(container.textContent).toContain("refresh failed")
})

it("loads changes for an outside-project session instead of showing the empty state", async () => {
  store.state = {
    selectedProject: null,
    sessionView: null,
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
  }
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo",
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  })

  await act(async () => {
    root.render(<ReviewTool />)
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10))
    await Promise.resolve()
  })

  expect(container.textContent).not.toContain("选择一个项目后可以查看文件 diff。")
  expect(mocks.queryGitChanges).toHaveBeenCalledWith(
    {
      rootPath: "D:/repo",
      scope: "uncommitted",
    },
    { force: false }
  )
})
