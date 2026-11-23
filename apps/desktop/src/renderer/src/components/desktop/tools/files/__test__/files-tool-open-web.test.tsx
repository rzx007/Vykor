// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

import { FilesTool } from "../files-tool"

vi.mock("@renderer/stores/desktop-session", () => ({
  selectActiveWorkspaceProject: () => ({ path: "D:/repo", name: "repo" }),
  useDesktopSessionStore: (selector: () => unknown) => selector(),
}))
vi.mock("../project-file-tree", () => ({
  ProjectFileTree: ({
    paths,
    onSelect,
    onRenderFile,
    onExpandDirectory,
  }: {
    paths: string[]
    onSelect: (path: string) => void
    onRenderFile: (path: string) => void
    onExpandDirectory?: (path: string) => void
  }) => (
    <>
      <button onClick={() => onSelect("index.html")}>select html</button>
      <button onClick={() => onRenderFile("image.svg")}>render svg</button>
      {onExpandDirectory && <button onClick={() => onExpandDirectory("nested")}>expand</button>}
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

it.each(["draft:repo", "session:agent"])("opens web files from the source selected by %s", async (scopeId) => {
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
    content: "agent workspace text",
    previewBytes: null,
    mediaType: null,
    binary: false,
  }))
  const listFiles = vi.fn(async ({ path }: { path?: string }) => ({
    entries: path === "nested" ? [{ path: "nested/note.txt", type: "file" }] : [
      { path: "index.html", type: "file" },
      { path: "image.svg", type: "file" },
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
  if (scopeId === "session:agent") {
    expect(listFiles).toHaveBeenCalledWith({ sessionId: "agent" })
    expect(readFile.mock.calls).toEqual([
      [{ sessionId: "agent", path: "index.html" }],
      [{ sessionId: "agent", path: "image.svg" }],
    ])
    expect(onFileOpened).toHaveBeenCalledWith(
      expect.objectContaining({ preview: expect.objectContaining({ content: "agent workspace text" }) })
    )
    expect(onOpenWebDocument).not.toHaveBeenCalled()
    expect(listFiles).toHaveBeenCalledTimes(1)
    await act(async () => {
      buttons[2].click()
      buttons[2].click()
    })
    expect(listFiles).toHaveBeenLastCalledWith({ sessionId: "agent", path: "nested" })
    expect(listFiles).toHaveBeenCalledTimes(2)
    await act(async () => host.querySelectorAll("button")[3].click())
    expect(readFile).toHaveBeenLastCalledWith({ sessionId: "agent", path: "nested/note.txt" })
  } else {
    expect(listFiles).toHaveBeenCalledWith({ rootPath: "D:/repo" })
    expect(onOpenWebDocument.mock.calls).toEqual([
      ["D:/repo", "index.html"],
      ["D:/repo", "image.svg"],
    ])
    expect(readFile).not.toHaveBeenCalled()
  }
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
