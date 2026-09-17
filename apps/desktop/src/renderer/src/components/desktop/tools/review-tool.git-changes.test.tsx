// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ queryGitChanges: vi.fn() }))
vi.mock("@renderer/lib/git-changes-query", () => ({
  queryGitChanges: mocks.queryGitChanges,
}))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector: (state: unknown) => unknown) => selector({
    selectedProject: { path: "D:/repo" },
    sessionView: null,
  }),
}))

import { ReviewTool } from "./review-tool"

beforeEach(() => {
  mocks.queryGitChanges.mockReset()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

it("forces a fresh query from the refresh button and keeps errors visible", async () => {
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo", files: [], totalAdditions: 0, totalDeletions: 0,
  })
  const container = document.createElement("div")
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(<ReviewTool />)
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })
  expect(mocks.queryGitChanges).toHaveBeenNthCalledWith(1, {
    rootPath: "D:/repo",
    scope: "uncommitted",
  }, { force: false })

  mocks.queryGitChanges.mockRejectedValueOnce(new Error("refresh failed"))
  const refresh = container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')
  await act(async () => {
    refresh?.click()
    await Promise.resolve()
  })
  expect(mocks.queryGitChanges).toHaveBeenLastCalledWith({
    rootPath: "D:/repo",
    scope: "uncommitted",
  }, { force: true })
  expect(container.textContent).toContain("refresh failed")
  act(() => root.unmount())
})
