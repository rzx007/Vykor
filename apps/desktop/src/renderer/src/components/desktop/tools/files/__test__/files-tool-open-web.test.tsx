// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

import { FilesTool } from "../files-tool"

vi.mock("../project-file-tree", () => ({
  ProjectFileTree: ({
    rootPath,
    paths,
    onSelect,
    onRenderFile,
  }: {
    rootPath: string
    paths: string[]
    onSelect: (path: string) => void
    onRenderFile: (path: string) => void
  }) => (
    <>
      <button onClick={() => onSelect("index.html")}>select html</button>
      <button onClick={() => onRenderFile("image.svg")}>render svg</button>
      <span data-testid="tree-root">{rootPath}</span>
      {paths.includes("nested/note.txt") &&
        <button onClick={() => onSelect("nested/note.txt")}>open nested file</button>}
    </>
  ),
}))
vi.mock("../file-viewer", () => ({ FileViewer: () => null }))
vi.mock("../file-viewer-toolbar", () => ({ FileViewerToolbar: () => null }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("opens a requested directory in the file manager instead of reading it as a file", async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  const readFile = vi.fn()
  const revealPath = vi.fn(async () => undefined)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { workspace: { listFiles: vi.fn(async () => ({ entries: [] })), readFile, revealPath } },
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <FilesTool
        scopeId="test"
        rootPath="D:/repo"
        tabs={[]}
        activePath={null}
        loadingPath={null}
        onActivePathChange={vi.fn()}
        onLoadingPathChange={vi.fn()}
        onOpenFileStart={vi.fn()}
        onFileOpened={vi.fn()}
        restoreActivePath={null}
        restorePaths={[]}
        openRequest={{ id: 1, path: "C:/outside/report/" }}
        onOpenWebDocument={vi.fn()}
      />
    )
  )
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  expect(revealPath).toHaveBeenCalledWith({ rootPath: "D:/repo", path: "C:/outside/report/" })
  expect(readFile).not.toHaveBeenCalled()
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it.each(["draft:repo", "session:agent"])("uses the complete local file tree in %s", async (scopeId) => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  const readFile = vi.fn(async ({ path }: { path: string }) => ({
    path,
    name: path,
    content: "local workspace text",
    scope: "project",
    previewBytes: null,
    mediaType: null,
    binary: false,
  }))
  const listFiles = vi.fn(async () => ({
    rootPath: "D:/repo",
    entries: [
      { path: "index.html", type: "file" },
      { path: "image.svg", type: "file" },
      { path: "nested/", type: "directory" },
      { path: "nested/note.txt", type: "file" },
    ],
  }))
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      workspace: {
        listFiles,
        readFile,
      },
    },
  })
  const onOpenWebDocument = vi.fn()
  const onFileOpened = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <FilesTool
        scopeId={scopeId}
        rootPath="D:/repo"
        tabs={[]}
        activePath={null}
        loadingPath={null}
        onActivePathChange={vi.fn()}
        onLoadingPathChange={vi.fn()}
        onOpenFileStart={vi.fn()}
        onFileOpened={onFileOpened}
        restoreActivePath={null}
        restorePaths={[]}
        openRequest={null}
        onOpenWebDocument={onOpenWebDocument}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const buttons = host.querySelectorAll("button")
  await act(async () => {
    buttons[0].click()
    buttons[1].click()
  })
  expect(listFiles).toHaveBeenCalledExactlyOnceWith({ rootPath: "D:/repo" })
  expect(host.querySelector('[data-testid="tree-root"]')?.textContent).toBe("D:/repo")
  expect(onOpenWebDocument.mock.calls).toEqual([
    ["D:/repo", "index.html"],
    ["D:/repo", "image.svg"],
  ])
  expect(readFile).not.toHaveBeenCalled()
  await act(async () => buttons[2].click())
  expect(readFile).toHaveBeenCalledExactlyOnceWith({ rootPath: "D:/repo", path: "nested/note.txt" })
  expect(onFileOpened).toHaveBeenCalledWith(expect.objectContaining({
    preview: expect.objectContaining({ content: "local workspace text", scope: "project" }),
  }))
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
