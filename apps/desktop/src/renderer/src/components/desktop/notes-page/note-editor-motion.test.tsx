// @vitest-environment jsdom
import { act, type ComponentType } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NoteSaveStatus } from "./note-save-coordinator"

const probe = vi.hoisted(() => ({
  reduced: false,
  frames: [] as Array<{
    layout?: unknown
    dependency?: unknown
    transition?: { duration?: number }
  }>,
}))

// 仍由真实 Motion 绘制，只记录编辑器交给布局动画引擎的尺寸更新请求。
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>()
  const react = await import("react")
  const create = (...args: Parameters<typeof actual.motion.create>) => {
    const Element = actual.motion.create(...args) as ComponentType<Record<string, unknown>>
    return function TracedFrame(props: Record<string, unknown>) {
      probe.frames.push({
        layout: props.layout,
        dependency: props.layoutDependency,
        transition: props.transition as { duration?: number },
      })
      return react.createElement(Element, props)
    }
  }
  return {
    ...actual,
    useReducedMotion: () => probe.reduced,
    motion: new Proxy(actual.motion, {
      get: (target, key) => (key === "create" ? create : Reflect.get(target, key)),
    }),
  }
})

import { NoteEditor } from "./note-editor"

describe("desktop note editor motion", () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe.reduced = false
    probe.frames.length = 0
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const lastFrame = () => probe.frames[probe.frames.length - 1]
  async function show(
    id: string,
    content: string,
    expanded = false,
    status: NoteSaveStatus = "saved"
  ) {
    await act(async () => {
      root.render(
        <NoteEditor
          selected={{
            draftId: id,
            noteId: id,
            content,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            recovered: false,
          }}
          content={content}
          expanded={expanded}
          status={status}
          error={null}
          onChange={() => {}}
          onRetry={() => {}}
          onReloadConflict={() => {}}
          onSaveConflictAsNew={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
          onExpand={() => {}}
        />
      )
    })
  }
  it("requests content-sized layout on paper selection without recreating the input", async () => {
    await show("short", "记一句")
    const editor = container.querySelector("textarea")!
    const before = lastFrame()?.dependency
    await show("long", "第一段\n第二段\n第三段\n第四段\n第五段\n第六段")
    expect(lastFrame()?.layout).toBe(true)
    expect(lastFrame()?.dependency).not.toBe(before)
    expect(container.querySelector("textarea")).toBe(editor)
    expect(editor.value).toContain("第六段")
    const selected = lastFrame()?.dependency
    await show("long", editor.value, false, "saving")
    expect(lastFrame()?.dependency).toBe(selected)
  })
  it("requests an expanded layout and its reverse while retaining text and cursor selection", async () => {
    await show("note", "光标留在这里")
    const editor = container.querySelector("textarea")!
    editor.setSelectionRange(2, 4)
    const collapsed = lastFrame()?.dependency
    await show("note", editor.value, true)
    expect(lastFrame()?.layout).toBe(true)
    expect(lastFrame()?.dependency).not.toBe(collapsed)
    expect(container.querySelector("textarea")).toBe(editor)
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 4])
    await show("note", editor.value)
    expect(lastFrame()?.dependency).toBe(collapsed)
    expect(editor.value).toBe("光标留在这里")
  })
  it("updates the live editor immediately when reduced motion is requested", async () => {
    probe.reduced = true
    await show("one", "第一句")
    await show("two", "第二句", true)
    expect(probe.frames.length).toBeGreaterThan(0)
    expect(probe.frames.every((frame) => !frame.layout && frame.transition?.duration === 0)).toBe(
      true
    )
    expect(container.querySelector("textarea")?.value).toBe("第二句")
  })
})
