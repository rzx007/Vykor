// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { expect, it, vi } from "vitest"

vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedProject: { path: "D:/repo" } }),
}))

import { resetGitChangesQueryCacheForTests } from "@renderer/lib/git-changes-query"
import { ChangedFilesSummary } from "./assistant-message"

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
  const container = document.createElement("div")
  const root: Root = createRoot(container)
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
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })

  expect(changes).toHaveBeenCalledTimes(1)
  expect(container.textContent?.match(/\+4/g)).toHaveLength(2)
  expect(container.textContent?.match(/-2/g)).toHaveLength(2)
  act(() => root.unmount())
  resetGitChangesQueryCacheForTests()
})
