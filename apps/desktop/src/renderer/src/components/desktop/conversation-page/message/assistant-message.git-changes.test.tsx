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
import { AssistantMessage, ChangedFilesSummary } from "./assistant-message"

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

it("keeps stored Run line counts and opens the recorded repository's current diff", async () => {
  const changes = vi.fn().mockResolvedValue({
    rootPath: "D:/other",
    files: [],
    totalAdditions: 999,
    totalDeletions: 999,
  })
  Object.defineProperty(window, "desktop", { configurable: true, value: { git: { changes } } })
  const onOpenReview = vi.fn()
  await act(async () => {
    root.render(
      <ChangedFilesSummary
        files={[{ path: "src/a.ts", additions: 0, deletions: 0, hasStats: false }]}
        observation={{
          version: 1,
          status: "complete",
          repositoryRoot: "D:/recorded",
          files: [{ path: "src/a.ts", status: "modified", lines: 7 }],
          fileCount: 1,
          totalLines: 7,
          truncated: false,
        }}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={onOpenReview}
      />
    )
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })
  expect(container.textContent).toContain("运行期间变更")
  expect(container.textContent).toContain("7 行变化")
  expect(container.textContent).toContain("当前工作区差异")
  expect(changes).not.toHaveBeenCalled()
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click()
  })
  expect(onOpenReview).toHaveBeenCalledWith("src/a.ts", "uncommitted", "D:/recorded")
})

it("preserves an outside-repository Write when the repository observation is empty", async () => {
  const changes = vi
    .fn()
    .mockResolvedValue({ rootPath: "D:/repo", files: [], totalAdditions: 0, totalDeletions: 0 })
  Object.defineProperty(window, "desktop", { configurable: true, value: { git: { changes } } })
  const part = {
    id: "write",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "tool" as const,
    toolName: "Write",
    toolUseId: "write",
    status: "completed" as const,
    input: { file_path: "D:/outside/result.txt", content: "result" },
    metadata: { executionState: "completed" },
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "complete",
            repositoryRoot: "D:/repo",
            files: [],
            fileCount: 0,
            totalLines: 0,
            truncated: false,
          },
        ]}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).not.toContain("仓库内 0 个文件")
  expect(container.textContent).toContain("D:/outside/result.txt")
  expect(container.textContent).toContain("已编辑 1 个文件")
})

it.each([
  "D:/repo/../outside/result.txt",
  "d:\\REPO\\..\\outside\\result.txt",
  "../outside/result.txt",
  "src/result.txt",
])("preserves Write facts when repository membership is outside or unproven: %s", async (path) => {
  const changes = vi
    .fn()
    .mockResolvedValue({ rootPath: "D:/repo", files: [], totalAdditions: 0, totalDeletions: 0 })
  Object.defineProperty(window, "desktop", { configurable: true, value: { git: { changes } } })
  const part = {
    id: "write",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "tool" as const,
    toolName: "Write",
    toolUseId: "write",
    status: "completed" as const,
    input: { file_path: path, content: "result" },
    metadata: { executionState: "completed" },
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "complete",
            repositoryRoot: "D:/repo",
            files: [],
            fileCount: 0,
            totalLines: 0,
            truncated: false,
          },
        ]}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).not.toContain("仓库内 0 个文件")
  expect(container.textContent).toContain("已编辑 1 个文件")
  expect(container.textContent).toContain(path)
})

it("hides an empty observation after a reply finishes", async () => {
  const part = {
    id: "text",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "text" as const,
    text: "done",
    status: "completed" as const,
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "complete",
            repositoryRoot: "D:/repo",
            files: [],
            fileCount: 0,
            totalLines: 0,
            truncated: false,
          },
        ]}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).toContain("done")
  expect(container.querySelector("section")).toBeNull()
})

it("hides an empty tool summary but preserves an observed nonzero count with a truncated file list", async () => {
  const props = { files: [], canOpenReview: true, onOpenFile: vi.fn(), onOpenReview: vi.fn() }
  await act(async () => {
    root.render(<ChangedFilesSummary {...props} />)
  })
  expect(container.querySelector("section")).toBeNull()

  await act(async () => {
    root.render(
      <ChangedFilesSummary
        {...props}
        observation={{
          version: 1,
          status: "complete",
          repositoryRoot: "D:/repo",
          files: [],
          fileCount: 2,
          totalLines: 7,
          truncated: true,
        }}
      />
    )
  })
  expect(container.textContent).toContain("仓库内 2 个文件")
  expect(container.textContent).toContain("摘要已截断")
})

it("shows a Shell-only Run's observed file despite having no file-tool parts", async () => {
  const part = {
    id: "shell",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "tool" as const,
    toolName: "Shell",
    toolUseId: "shell",
    status: "completed" as const,
    input: { command: "node offline-script.cjs" },
    metadata: { executionState: "completed" },
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "complete",
            repositoryRoot: "D:/repo",
            files: [{ path: "shell-output.txt", status: "added", lines: 1 }],
            fileCount: 1,
            totalLines: 1,
            truncated: false,
          },
        ]}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).toContain("shell-output.txt")
  expect(container.textContent).toContain("运行期间变更")
})

it("does not warn when a finished reply's directory is not a Git repository", async () => {
  const part = {
    id: "text",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "text" as const,
    text: "done",
    status: "completed" as const,
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "unavailable",
            reason: "not_git_repository",
            files: [],
            fileCount: 0,
            totalLines: 0,
            truncated: false,
          },
        ]}
        canOpenReview={false}
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).toContain("done")
  expect(container.textContent).not.toContain("运行期间变更无法确认")
  expect(container.querySelector("section")).toBeNull()
})

it("preserves actual file-tool changes without warning in a non-Git directory", async () => {
  const part = {
    id: "write",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "tool" as const,
    toolName: "Write",
    toolUseId: "write",
    status: "completed" as const,
    input: { file_path: "D:/scratch/result.txt", content: "result" },
    metadata: { executionState: "completed" },
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "unavailable",
            reason: "not_git_repository",
            files: [],
            fileCount: 0,
            totalLines: 0,
            truncated: false,
          },
        ]}
        canOpenReview={false}
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).not.toContain("运行期间变更无法确认")
  expect(container.textContent).toContain("已编辑 1 个文件")
  expect(container.textContent).toContain("D:/scratch/result.txt")
})

it("hides an unavailable observation when there are no changed files", async () => {
  const part = {
    id: "text",
    sessionId: "s",
    messageId: "m",
    seq: 1,
    type: "text" as const,
    text: "done",
    status: "completed" as const,
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
  }
  await act(async () => {
    root.render(
      <AssistantMessage
        parts={[part]}
        streaming={false}
        observations={[
          {
            version: 1,
            status: "unavailable",
            reason: "observation_budget_exceeded",
            files: [],
            fileCount: 0,
            totalLines: 0,
            truncated: false,
          },
        ]}
        canOpenReview
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  })
  expect(container.textContent).not.toContain("运行期间变更无法确认")
  expect(container.textContent).not.toContain("观察超过时间预算")
  expect(container.textContent).not.toContain("仓库内 0 个文件")
  expect(container.querySelector("section")).toBeNull()
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
