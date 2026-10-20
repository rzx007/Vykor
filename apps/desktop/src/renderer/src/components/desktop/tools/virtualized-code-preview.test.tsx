// @vitest-environment jsdom
import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CodeViewProps } from "@pierre/diffs/react"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { VirtualizedCodePreview } from "./virtualized-code-preview"
import { useCodePreviewDrafts } from "./code-preview-drafts"
import { useEditorPreferences } from "@renderer/stores/editor-preferences"

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
    useEditorPreferences.setState({ readOnly: false, wordWrap: true, tabSize: 2 })
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
  async function save() {
    await act(async () =>
      container.firstElementChild!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })
      )
    )
  }
  async function menu(label: string) {
    await act(async () =>
      container.firstElementChild!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2 })
      )
    )
    const item = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
      (node) => node.textContent?.replace("✓ ", "") === label
    )
    expect(item, label).toBeTruthy()
    await act(async () => item!.click())
  }
  async function readOnly(value: boolean) {
    await act(async () => useEditorPreferences.getState().update({ readOnly: value }))
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

  it("opens editable and wrapped, saves by keyboard, and has no persistent editor toolbar", async () => {
    expect(codeView.props!.items![0]!.edit).toBe(true)
    expect(codeView.props!.options?.overflow).toBe("wrap")
    expect(container.querySelector("button")).toBeNull()
    write.mockResolvedValue({ ...preview, content: "draft" })
    await type("draft")
    await act(async () =>
      container.firstElementChild!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })
      )
    )
    expect(write).toHaveBeenCalledWith({
      rootPath: "/project",
      path: "a.ts",
      originalContent: "original",
      content: "draft",
    })
  })

  it("keeps live edits out of the controlled file until completion, and resumes drafts after remount", async () => {
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
  it("rereads a clean editable file without retaining stale text or history", async () => {
    const id = useCodePreviewDrafts.getState().drafts[draftKey]!.id
    await render({ ...preview, content: "external update" })
    expect(codeView.text).toBe("external update")
    expect(useCodePreviewDrafts.getState().drafts[draftKey]).toMatchObject({
      originalContent: "external update",
      content: "external update",
      editing: true,
    })
    expect(useCodePreviewDrafts.getState().drafts[draftKey]!.id).not.toBe(id)
  })
  it("retains newer typing while the saved snapshot becomes the next disk baseline", async () => {
    let finish!: (value: WorkspaceReadFileResult) => void
    write.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await type("snapshot")
    await save()
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
  })
  it("preserves the draft and baseline when saving conflicts with an external update", async () => {
    write.mockRejectedValue(new Error("文件已被其他程序修改"))
    await type("draft")
    await save()
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
    await type("saved snapshot")
    await readOnly(true)
    await save()
    await act(async () => root.unmount())
    await act(async () => finish({ ...preview, content: "saved snapshot" }))
    root = createRoot(container)
    await render()
    const restored = codeView.props!.items![0]!
    expect(restored.type === "file" && restored.file.contents).toBe("saved snapshot")
    expect(useCodePreviewDrafts.getState().drafts[draftKey]?.content).toBe(
      useCodePreviewDrafts.getState().drafts[draftKey]?.originalContent
    )
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
    await type("saved snapshot")
    await render(reread)
    await readOnly(true)
    await save()
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
    await type("draft")
    await menu("只读")
    const completed = codeView.props!.items![0]!
    expect(completed.type === "file" && completed.file.contents).toBe("draft")
    await menu("只读")
    await menu("放弃改动并重新载入")
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "放弃并重新读取"
    )!
    await act(async () => confirm.click())
    const reset = codeView.props!.items![0]!
    expect(reset.type === "file" && reset.file.contents).toBe("disk content")
    expect(reset.edit).toBe(true)
    expect(useCodePreviewDrafts.getState().drafts[draftKey]?.originalContent).toBe("disk content")
    expect(codeView.text).toBe("disk content")
  })
})
