// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ queryGitChanges: vi.fn() }))
vi.mock("@renderer/lib/git-changes-query", () => ({
  queryGitChanges: mocks.queryGitChanges,
}))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectedProject: { path: "D:/repo" },
      sessionView: null,
    }),
}))

import { ReviewTool } from "./review-tool"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.queryGitChanges.mockReset()
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
