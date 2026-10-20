// @vitest-environment jsdom
import { act, useState } from "react"
import { Editor } from "@pierre/diffs/edit"
import {
  DEFAULT_THEMES,
  getSharedHighlighter,
  renderFileWithHighlighter,
  type DiffsHighlighter,
  type RenderFileOptions,
} from "@pierre/diffs"
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker"
import { WorkerPoolContext } from "@pierre/diffs/react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { VirtualizedCodePreview } from "../virtualized-code-preview"
import { useCodePreviewDrafts } from "../code-preview-drafts"
import { useEditorPreferences } from "@renderer/stores/editor-preferences"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

vi.mock("@renderer/components/ui/code-highlighting-provider", () => ({
  CodeHighlightingProvider: ({ children }: { children: React.ReactNode }) => (
    <WorkerPoolContext value={pool}>{children}</WorkerPoolContext>
  ),
}))
let pool: WorkerPoolManager, highlighter: DiffsHighlighter
let holdHighlights = false
const pendingHighlights: Array<() => void> = []
// jsdom 没有 Web Worker；只替换消息传输，保留真实高亮、缓存和布局流程。
class HighlightWorker extends EventTarget {
  options: RenderFileOptions = {
    theme: DEFAULT_THEMES,
    useTokenTransformer: false,
    tokenizeMaxLineLength: 4000,
  }
  terminated = false
  postMessage(input: WorkerRequest) {
    const request = structuredClone(input)
    const respond = () => {
      if (this.terminated) return
      let response: WorkerResponse
      if (request.type === "initialize" || request.type === "set-render-options") {
        this.options = request.renderOptions
        response = {
          type: "success",
          requestType: request.type,
          id: request.id,
          sentAt: Date.now(),
        }
      } else if (request.type === "file") {
        response = {
          type: "success",
          requestType: "file",
          id: request.id,
          result: renderFileWithHighlighter(request.file, highlighter, this.options),
          options: this.options,
          sentAt: Date.now(),
        }
      } else throw new Error("Unexpected diff worker request")
      this.dispatchEvent(new MessageEvent("message", { data: structuredClone(response) }))
    }
    if (request.type === "file" && holdHighlights) pendingHighlights.push(respond)
    else queueMicrotask(respond)
  }
  terminate() {
    this.terminated = true
  }
}

const preview = {
  path: "NOTES",
  name: "NOTES",
  language: "text",
  content: "const value = 1\n",
  size: 16,
  binary: false,
  scope: "project",
  relativePath: "NOTES",
  rootLabel: "project",
  previewBytes: null,
  mediaType: null,
  imagePreviewError: null,
} satisfies WorkspaceReadFileResult
function PreviewHarness({ initial = preview }: { initial?: WorkspaceReadFileResult }) {
  const [value, setValue] = useState<WorkspaceReadFileResult>(initial)
  return (
    <VirtualizedCodePreview
      preview={value}
      themeType="light"
      searchQuery=""
      scopeId="session:chat"
      projectPath="/project"
      onSaved={setValue}
    />
  )
}
let root: Root, container: HTMLDivElement
const resizes = new Set<ResizeObserverCallback>()
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  useCodePreviewDrafts.setState({ drafts: {} })
  useEditorPreferences.setState({ readOnly: false, wordWrap: true, tabSize: 2 })
  holdHighlights = false
  pendingHighlights.length = 0
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {
        resizes.add(callback)
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect() {
        resizes.delete(this.callback)
      }
    }
  )
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 600,
    right: 800,
    width: 800,
    height: 600,
    toJSON() {
      return {}
    },
  })
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as never)
  vi.spyOn(Editor.prototype, "edit")
  // Pierre 使用浏览器允许省略 targetOrigin 的同窗口消息；jsdom 尚要求该参数。
  const postMessage = window.postMessage.bind(window)
  vi.spyOn(window, "postMessage").mockImplementation((message, options) =>
    postMessage(message, typeof options === "string" ? options : (options?.targetOrigin ?? "*"))
  )
  HTMLElement.prototype.scrollIntoView = vi.fn()
  Range.prototype.getClientRects = vi.fn(() => {
    const rect = new DOMRect(0, 0, 8, 16)
    return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) })
  })
  Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect())
  window.desktop = {
    workspace: {
      writeFile: vi.fn(async ({ content }: { content: string }) => ({ ...preview, content })),
    },
    clipboard: { readText: vi.fn(async () => ""), writeText: vi.fn(async () => {}) },
  } as never
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  highlighter = await getSharedHighlighter({
    themes: ["pierre-dark", "pierre-light"],
    langs: ["typescript"],
    preferredHighlighter: "shiki-js",
  })
  pool = new WorkerPoolManager(
    { poolSize: 1, workerFactory: () => new HighlightWorker() as unknown as Worker },
    { langs: ["typescript"], preferredHighlighter: "shiki-js", tokenizeMaxLineLength: 4000 }
  )
  await pool.initialize()
})
afterEach(async () => {
  await act(async () => root.unmount())
  pool.terminate()
  container.remove()
  resizes.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const setReadOnly = async (readOnly: boolean) => {
  await act(async () => useEditorPreferences.getState().update({ readOnly }))
}
const save = async () => {
  await act(async () =>
    container.firstElementChild!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })
    )
  )
}
it.each([
  { path: "NOTES", saveWhileEditing: true, content: "const value = 2\n" },
  { path: "NOTES", saveWhileEditing: false, content: "const value = 2\n" },
  { path: "a.ts", saveWhileEditing: true, content: "const value = 2\n" },
  { path: "a.ts", saveWhileEditing: false, content: "const value = 2\n" },
  { path: "a.ts", saveWhileEditing: true, content: "" },
  { path: "a.ts", saveWhileEditing: false, content: "" },
])(
  "saves $path with the real layout and can edit again (editing: $saveWhileEditing, saved: '$content')",
  async ({ path, saveWhileEditing, content }) => {
    const errors = vi.spyOn(console, "error")
    const initial = {
      ...preview,
      path,
      name: path,
      relativePath: path,
      language: path === "a.ts" ? "typescript" : "text",
    }
    vi.mocked(window.desktop.workspace.writeFile).mockImplementation(async ({ content }) => ({
      ...initial,
      content,
    }))
    await act(async () => root.render(<PreviewHarness initial={initial} />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const editor = vi.mocked(Editor.prototype.edit).mock.contexts.at(-1) as Editor
    expect(editor).toBeInstanceOf(Editor)
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: content,
        },
      ])
    )
    expect(editor.getText()).toBe(content)
    holdHighlights = true
    if (!saveWhileEditing) await setReadOnly(true)
    await save()
    if (saveWhileEditing) await setReadOnly(true)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    await act(async () => {
      holdHighlights = false
      for (const finish of pendingHighlights.splice(0)) finish()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    await act(async () => {
      for (const callback of resizes)
        callback(
          [{ target: container.querySelector(".desktop-code-file")! } as ResizeObserverEntry],
          {} as ResizeObserver
        )
    })
    expect(window.desktop.workspace.writeFile).toHaveBeenCalledWith({
      rootPath: "/project",
      path,
      originalContent: "const value = 1\n",
      content,
    })
    const rendered = container
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector("[data-code]")
    expect(rendered).toBeTruthy()
    expect(rendered!.textContent).toContain(content.trim())
    const key = JSON.stringify(["session:chat", "/project", path])
    expect(useCodePreviewDrafts.getState().drafts[key]?.originalContent).toBe(content)
    // 切到别的文件再回来也保留撤销历史。
    await act(async () => root.render(null))
    await act(async () => root.render(<PreviewHarness initial={{ ...initial, content }} />))
    await setReadOnly(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const resumed = vi.mocked(Editor.prototype.edit).mock.contexts.at(-1) as Editor
    expect(resumed.getText()).toBe(content)
    expect(resumed.canUndo).toBe(true)
    await act(async () => resumed.undo())
    expect(resumed.getText()).toBe(initial.content)
    await act(async () => resumed.redo())
    expect(resumed.getText()).toBe(content)
    if (path === "a.ts" && saveWhileEditing && content) {
      await act(async () =>
        resumed.setSelections([
          {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
            direction: "forward",
          },
        ])
      )
      await act(async () =>
        container.firstElementChild!.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, button: 2 })
        )
      )
      const copy = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === "复制"
      )!
      expect(copy).toBeTruthy()
      await act(async () => copy.click())
      expect(window.desktop.clipboard.writeText).toHaveBeenCalledWith("const")
    }
    await act(async () =>
      resumed.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "again ",
        },
      ])
    )
    expect(resumed.getText()).toBe(`again ${content}`)
    expect(useCodePreviewDrafts.getState().drafts[key]?.content).toBe(`again ${content}`)
    expect(errors).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("rendered a different file")
  }
)
