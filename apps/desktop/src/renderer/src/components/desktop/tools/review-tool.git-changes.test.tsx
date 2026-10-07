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
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      git: {
        fileDiff: vi.fn(async () => ({ path: "manual.ts", patch: "(no diff)", binary: false })),
      },
    },
  })
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

it("uses saved default range, whitespace and view preferences in the real review panel", async () => {
  Object.defineProperty(window.desktop, "gitSettings", {
    value: {
      readPreferences: vi.fn(async () => ({
        defaultScope: "staged",
        ignoreWhitespace: true,
        viewMode: "split",
      })),
    },
  })
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo",
    files: [{ path: "manual.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
    totalAdditions: 1,
    totalDeletions: 1,
  })
  await act(async () => {
    root.render(<ReviewTool />)
    await Promise.resolve()
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  })
  expect(mocks.queryGitChanges).toHaveBeenCalledWith(
    { rootPath: "D:/repo", scope: "staged", ignoreWhitespace: true },
    { force: false }
  )
  expect(window.desktop.git.fileDiff).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "staged", ignoreWhitespace: true })
  )
  expect(container.querySelector('[aria-label="切换到统一 diff"]')).not.toBeNull()
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

  expect(container.textContent).not.toContain("当前工作目录不可用。")
  expect(mocks.queryGitChanges).toHaveBeenCalledWith(
    {
      rootPath: "D:/repo",
      scope: "uncommitted",
    },
    { force: false }
  )
})

it("uses the recorded Run repository for current changes and patch even when another project is selected", async () => {
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/recorded",
    files: [{ path: "manual.ts", status: "modified", additions: 12, deletions: 3, binary: false }],
    totalAdditions: 12,
    totalDeletions: 3,
  })
  await act(async () => {
    root.render(
      <ReviewTool
        openRequest={{ id: 7, scope: "uncommitted", rootPath: "D:/recorded", path: "manual.ts" }}
      />
    )
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
  expect(mocks.queryGitChanges).toHaveBeenCalledWith(
    { rootPath: "D:/recorded", scope: "uncommitted" },
    { force: false }
  )
  expect(window.desktop.git.fileDiff).toHaveBeenCalledWith(
    expect.objectContaining({ rootPath: "D:/recorded", path: "manual.ts", scope: "uncommitted" })
  )
  expect(container.textContent).toContain("当前工作区差异")
})

it("opens the work summary's uncommitted range instead of filtering it to the last turn", async () => {
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo",
    files: [{ path: "manual.ts", status: "modified", additions: 12, deletions: 3, binary: false }],
    totalAdditions: 12,
    totalDeletions: 3,
  })
  await act(async () => {
    root.render(<ReviewTool openRequest={{ id: 1, scope: "uncommitted" }} />)
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })
  expect(container.textContent).toContain("manual.ts")
  expect(container.textContent).toContain("未提交")
  expect(container.textContent).toContain("+12")
})

it("switches an already mounted review panel to the summary's requested range", async () => {
  Object.defineProperty(window.desktop, "gitSettings", {
    value: {
      readPreferences: vi.fn(async () => ({
        defaultScope: "staged",
        ignoreWhitespace: false,
        viewMode: "unified",
      })),
    },
  })
  mocks.queryGitChanges.mockImplementation(async ({ scope }) => ({
    rootPath: "D:/repo",
    files:
      scope === "staged"
        ? []
        : [{ path: "manual.ts", status: "modified", additions: 12, deletions: 3, binary: false }],
    totalAdditions: 12,
    totalDeletions: 3,
  }))
  await act(async () => {
    root.render(<ReviewTool />)
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
  expect(container.textContent).not.toContain("manual.ts")
  await act(async () => {
    root.render(<ReviewTool openRequest={{ id: 2, scope: "uncommitted" }} />)
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
  expect(container.textContent).toContain("manual.ts")
  expect(container.textContent).toContain("未提交")
})
