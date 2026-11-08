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
    onSelect,
    onRenderFile,
  }: {
    onSelect: (path: string) => void
    onRenderFile: (path: string) => void
  }) => (
    <>
      <button onClick={() => onSelect("index.html")}>select html</button>
      <button onClick={() => onRenderFile("image.svg")}>render svg</button>
    </>
  ),
}))
vi.mock("../file-viewer", () => ({ FileViewer: () => null }))
vi.mock("../file-viewer-toolbar", () => ({ FileViewerToolbar: () => null }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("opens web files selected in the tree directly in the browser", async () => {
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
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      workspace: {
        listFiles: vi.fn(async () => ({
          entries: [
            { path: "index.html", type: "file" },
            { path: "image.svg", type: "file" },
          ],
        })),
        readFile,
      },
    },
  })
  const onOpenWebDocument = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
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
  expect(onOpenWebDocument.mock.calls).toEqual([
    ["D:/repo", "index.html"],
    ["D:/repo", "image.svg"],
  ])
  expect(readFile).not.toHaveBeenCalled()
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
