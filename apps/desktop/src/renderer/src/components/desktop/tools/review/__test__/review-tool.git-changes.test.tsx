// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { webcrypto } from "node:crypto"
import { useReviewedFiles } from "../reviewed-files"

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
vi.mock("../review-diff-preview", () => ({
  ReviewDiffPreview: ({ patch, refreshing }: { patch: string; refreshing?: boolean }) => (
    <pre data-review-patch aria-busy={refreshing}>
      {patch}
    </pre>
  ),
}))
vi.mock("@renderer/stores/desktop-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/stores/desktop-session")>()
  return {
    ...actual,
    useDesktopSessionStore: (selector: (state: unknown) => unknown) => selector(store.state),
  }
})

import { ReviewTool } from "../review-tool"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto)
  useReviewedFiles.setState({ marks: {} })
  HTMLElement.prototype.getAnimations ??= () => []
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
  vi.unstubAllGlobals()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

const realPatch = (word: string) =>
  [
    "diff --git a/manual.ts b/manual.ts",
    "--- a/manual.ts",
    "+++ b/manual.ts",
    "@@ -1 +1 @@",
    "-old",
    `+${word}`,
    "",
  ].join("\n")
async function settleReview() {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    })
}
const listing = () => ({
  rootPath: "D:/repo",
  files: [{ path: "manual.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
  totalAdditions: 1,
  totalDeletions: 1,
})

it("keeps the current diff mounted and its scroll position while refreshing", async () => {
  mocks.queryGitChanges.mockResolvedValue(listing())
  vi.mocked(window.desktop.git.fileDiff).mockResolvedValue({
    path: "manual.ts",
    patch: realPatch("first"),
    binary: false,
  })
  await act(async () => root.render(<ReviewTool />))
  await settleReview()
  const node = container.querySelector("[data-review-patch]")!
  const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
  viewport.scrollTop = 240
  let finish!: (value: { path: string; patch: string; binary: boolean }) => void
  vi.mocked(window.desktop.git.fileDiff).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')!.click()
  )
  await settleReview()
  expect(container.querySelector("[data-review-patch]")).toBe(node)
  viewport.scrollTop = 320
  viewport.dispatchEvent(new Event("scroll"))
  await act(async () => finish({ path: "manual.ts", patch: realPatch("second"), binary: false }))
  await settleReview()
  expect(container.querySelector("[data-review-patch]")).toBe(node)
  expect(node.textContent).toContain("+second")
  expect(viewport.scrollTop).toBe(320)
})

it("clears an active reviewed mark when an equal-length patch changes", async () => {
  mocks.queryGitChanges.mockResolvedValue(listing())
  vi.mocked(window.desktop.git.fileDiff).mockResolvedValue({
    path: "manual.ts",
    patch: realPatch("aaa"),
    binary: false,
  })
  await act(async () => root.render(<ReviewTool scopeId="session:test" />))
  await settleReview()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="标记为已审阅"]')!.click()
  )
  await settleReview()
  expect(container.querySelector('[aria-label="标记为未审阅"]')).not.toBeNull()
  vi.mocked(window.desktop.git.fileDiff).mockResolvedValue({
    path: "manual.ts",
    patch: realPatch("bbb"),
    binary: false,
  })
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')!.click()
  )
  await settleReview()
  expect(container.querySelector('[aria-label="标记为未审阅"]')).toBeNull()
})

it("keeps the last patch visible on refresh failure and permits a retry", async () => {
  mocks.queryGitChanges.mockResolvedValue(listing())
  vi.mocked(window.desktop.git.fileDiff).mockResolvedValue({
    path: "manual.ts",
    patch: realPatch("first"),
    binary: false,
  })
  await act(async () => root.render(<ReviewTool />))
  await settleReview()
  const node = container.querySelector("[data-review-patch]")!
  vi.mocked(window.desktop.git.fileDiff).mockRejectedValueOnce(new Error("patch unavailable"))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')!.click()
  )
  await settleReview()
  expect(container.querySelector("[data-review-patch]")).toBe(node)
  expect(node.textContent).toContain("+first")
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("patch unavailable")
  expect(container.querySelector<HTMLButtonElement>('[aria-label="标记为已审阅"]')!.disabled).toBe(
    true
  )
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')!.click()
  )
  await settleReview()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector<HTMLButtonElement>('[aria-label="标记为已审阅"]')!.disabled).toBe(
    false
  )
})

it("invalidates an inactive reviewed file during refresh", async () => {
  const changes = listing()
  changes.files.push({ ...changes.files[0]!, path: "other.ts" })
  mocks.queryGitChanges.mockResolvedValue(changes)
  let otherPatch = realPatch("old")
  vi.mocked(window.desktop.git.fileDiff).mockImplementation(async ({ path }) => ({
    path,
    patch: path === "other.ts" ? otherPatch : realPatch("main"),
    binary: false,
  }))
  await act(async () => root.render(<ReviewTool />))
  await settleReview()
  const other = container.querySelector('section[aria-label="other.ts"]')!
  await act(async () =>
    other.querySelector<HTMLButtonElement>('[aria-label="标记为已审阅"]')!.click()
  )
  await settleReview()
  expect(other.querySelector('[aria-label="标记为未审阅"]')).not.toBeNull()
  otherPatch = realPatch("new")
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')!.click()
  )
  await settleReview()
  expect(other.querySelector('[aria-label="标记为未审阅"]')).toBeNull()
})

it("does not install a late patch from the previously selected project", async () => {
  mocks.queryGitChanges.mockResolvedValue(listing())
  let finish!: (value: { path: string; patch: string; binary: boolean }) => void
  vi.mocked(window.desktop.git.fileDiff)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue({ path: "manual.ts", patch: realPatch("current"), binary: false })
  await act(async () => root.render(<ReviewTool />))
  await settleReview()
  store.state = { selectedProject: { path: "D:/other" }, sessionView: null }
  await act(async () => root.render(<ReviewTool />))
  await settleReview()
  await act(async () => finish({ path: "manual.ts", patch: realPatch("stale"), binary: false }))
  await settleReview()
  expect(container.querySelector("[data-review-patch]")?.textContent).toContain("+current")
  expect(container.textContent).not.toContain("+stale")
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

it("refreshes the current patch even when the file path and status are unchanged", async () => {
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo",
    files: [{ path: "manual.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
    totalAdditions: 1,
    totalDeletions: 1,
  })
  await act(async () => root.render(<ReviewTool />))
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 35))
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 35))
  })
  const previous = vi.mocked(window.desktop.git.fileDiff).mock.calls.length
  expect(previous).toBeGreaterThan(0)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')!.click()
  )
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 35))
  })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 35))
  })
  expect(window.desktop.git.fileDiff).toHaveBeenCalledTimes(previous + 1)
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
