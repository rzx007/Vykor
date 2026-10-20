// @vitest-environment jsdom
import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CodeViewProps } from "@pierre/diffs/react"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { VirtualizedCodePreview } from "./virtualized-code-preview"
import { useCodePreviewDrafts } from "./code-preview-drafts"

const codeView = vi.hoisted(() => ({
  props: null as CodeViewProps<undefined, undefined> | null,
  text: "",
}))
vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: CodeViewProps<undefined, undefined>) => {
    codeView.props = props
    const item = props.items![0]!
    useEffect(() => {
      if (!item.edit || item.type !== "file") return
      codeView.text = item.file.contents
      return () => {
        const next = {
          ...item,
          edit: false,
          version: (item.version ?? 0) + 1,
          file: { ...item.file, contents: codeView.text },
        }
        props.onItemEditComplete?.({ file: next.file } as never, item, next)
      }
      // CodeView completes only when editing ends, not when the owner rerenders.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.edit])
    return <div data-code-view />
  },
  EditProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@renderer/components/ui/code-highlighting-provider", () => ({
  CodeHighlightingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("./code-selection-actions", () => ({
  createCodeSelectionAction: () => () => document.createElement("div"),
  addCodeSelectionToComposer: vi.fn(),
}))

const preview = {
  path: "a.ts",
  name: "a.ts",
  language: "typescript",
  content: "original",
  size: 8,
  binary: false,
  scope: "project",
  relativePath: "a.ts",
  rootLabel: "project",
  previewBytes: null,
  mediaType: null,
  imagePreviewError: null,
} satisfies WorkspaceReadFileResult
const draftKey = JSON.stringify(["session:chat", "/project", "a.ts"])
describe("source preview editing lifecycle", () => {
  let container: HTMLDivElement
  let root: Root
  const saved = vi.fn()
  const write = vi.fn()
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    useCodePreviewDrafts.setState({ drafts: {} })
    saved.mockReset()
    write.mockReset()
    window.desktop = {
      workspace: {
        writeFile: write,
        readFile: vi.fn(async () => ({ ...preview, content: "disk content" })),
      },
    } as never
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await render()
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  async function render(value: WorkspaceReadFileResult = preview) {
    await act(async () =>
      root.render(
        <VirtualizedCodePreview
          preview={value}
          themeType="light"
          searchQuery=""
          scopeId="session:chat"
          projectPath="/project"
          onSaved={saved}
        />
      )
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === label
    )
    expect(button, label).toBeTruthy()
    await act(async () => button!.click())
  }
  async function type(contents: string) {
    codeView.text = contents
    await act(async () =>
      codeView.props!.onItemEditChange!(
        { file: { name: "a.ts", contents } } as never,
        codeView.props!.items![0]!
      )
    )
  }

  it("keeps live edits out of the controlled file until completion, and resumes drafts after remount", async () => {
    await click("编辑")
    expect(codeView.props!.items![0]!.edit).toBe(true)
    await type("draft")
    const item = codeView.props!.items![0]!
    expect(item.type === "file" && item.file.contents).toBe("original")
    expect(useCodePreviewDrafts.getState().drafts[draftKey]?.content).toBe("draft")
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    const restored = codeView.props!.items![0]!
    expect(restored.type === "file" && restored.file.contents).toBe("draft")
    expect(restored.edit).toBe(true)
  })
  it("retains newer typing while the saved snapshot becomes the next disk baseline", async () => {
    let finish!: (value: WorkspaceReadFileResult) => void
    write.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await click("编辑")
    await type("snapshot")
    await click("保存")
    await type("newer draft")
    await act(async () => finish({ ...preview, content: "snapshot" }))
    expect(write).toHaveBeenCalledWith({
      rootPath: "/project",
      path: "a.ts",
      originalContent: "original",
      content: "snapshot",
    })
    expect(useCodePreviewDrafts.getState().drafts[draftKey]).toMatchObject({
      originalContent: "snapshot",
      content: "newer draft",
    })
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ content: "snapshot" }))
    expect(container.textContent).toContain("未保存")
  })
  it("preserves the draft and baseline when saving conflicts with an external update", async () => {
    write.mockRejectedValue(new Error("文件已被其他程序修改"))
    await click("编辑")
    await type("draft")
    await click("保存")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("已被其他程序修改")
    expect(useCodePreviewDrafts.getState().drafts[draftKey]).toMatchObject({
      originalContent: "original",
      content: "draft",
    })
    expect(saved).not.toHaveBeenCalled()
  })
  it("does not restore a stale panel snapshot when a save finishes after leaving the chat", async () => {
    let finish!: (value: WorkspaceReadFileResult) => void
    write.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await click("编辑")
    await type("saved snapshot")
    await click("完成编辑")
    await click("保存")
    await act(async () => root.unmount())
    await act(async () => finish({ ...preview, content: "saved snapshot" }))
    root = createRoot(container)
    await render()
    const restored = codeView.props!.items![0]!
    expect(restored.type === "file" && restored.file.contents).toBe("saved snapshot")
    expect(container.textContent).not.toContain("未保存")
  })
  it("also preserves a late save after the preview was reread during editing", async () => {
    let finish!: (value: WorkspaceReadFileResult) => void
    write.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const reread = { ...preview }
    await click("编辑")
    await type("saved snapshot")
    await render(reread)
    await click("完成编辑")
    await click("保存")
    await act(async () => root.unmount())
    await act(async () => finish({ ...preview, content: "saved snapshot" }))
    root = createRoot(container)
    await render(reread)
    const restored = codeView.props!.items![0]!
    expect(restored.type === "file" && restored.file.contents).toBe("saved snapshot")
    await render({ ...preview, content: "external update" })
    const updated = codeView.props!.items![0]!
    expect(updated.type === "file" && updated.file.contents).toBe("external update")
  })
  it("keeps completed edits visible and installs the disk copy when a draft is explicitly discarded", async () => {
    await click("编辑")
    await type("draft")
    await click("完成编辑")
    const completed = codeView.props!.items![0]!
    expect(completed.type === "file" && completed.file.contents).toBe("draft")
    await click("编辑")
    await click("放弃改动")
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "放弃并重新读取"
    )!
    await act(async () => confirm.click())
    const reset = codeView.props!.items![0]!
    expect(reset.type === "file" && reset.file.contents).toBe("disk content")
    expect(reset.edit).toBe(false)
    expect(useCodePreviewDrafts.getState().drafts[draftKey]).toBeUndefined()
    await click("编辑")
    expect(codeView.text).toBe("disk content")
  })
})
