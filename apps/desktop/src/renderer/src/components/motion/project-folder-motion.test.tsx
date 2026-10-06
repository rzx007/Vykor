// @vitest-environment jsdom
import { act, useState, type ComponentType } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const probe = vi.hoisted(() => ({
  reduced: false,
  covers: [] as string[],
  papers: [] as Array<{ layoutId?: string; layout?: unknown; initial?: unknown }>,
}))

// 记录传给动画引擎的纸片身份，但保留真实 Motion 渲染和关闭回调。
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>()
  const react = await import("react")
  const trace = (tag: "div" | "span") => {
    const Element = actual.motion[tag] as ComponentType<Record<string, unknown>>
    return function TracedMotion(props: Record<string, unknown>) {
      if (tag === "span" && typeof props.layoutId === "string") probe.covers.push(props.layoutId)
      if (tag === "div" && props.layout !== undefined)
        probe.papers.push({
          layoutId: props.layoutId as string | undefined,
          layout: props.layout,
          initial: props.initial,
        })
      return react.createElement(Element, props)
    }
  }
  const div = trace("div")
  const span = trace("span")
  return {
    ...actual,
    useReducedMotion: () => probe.reduced,
    motion: new Proxy(actual.motion, {
      get: (target, key) =>
        key === "div" ? div : key === "span" ? span : Reflect.get(target, key),
    }),
  }
})

import { ProjectFolder } from "./project-folder"
import { NoteList } from "../desktop/notes-page/note-list"

const notes = Array.from({ length: 7 }, (_, index) => ({
  draftId: "paper-" + index,
  noteId: "paper-" + index,
  content: "想法 " + index,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  recovered: false,
}))

function Collection(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <ProjectFolder
      title="便签"
      ariaLabel="打开收纳夹"
      expanded={expanded}
      onExpandedChange={setExpanded}
      count={notes.length}
      previews={notes.slice(0, 5).map((note) => ({ id: note.draftId, content: note.content }))}
      expandedContent={
        <NoteList
          notes={notes}
          selectedKey={null}
          query=""
          loading={false}
          onCreate={() => {}}
          onSelect={() => {}}
        />
      }
    />
  )
}

describe("folder paper motion bridge", () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe.reduced = false
    probe.covers.length = 0
    probe.papers.length = 0
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  it("passes the cover's paper identities to the full collection while retaining all seven papers", async () => {
    await act(async () => {
      root.render(<Collection />)
    })
    const coverIds = [...new Set(probe.covers)]
    expect(coverIds).toHaveLength(5)
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    const expandedIds = [
      ...new Set(probe.papers.flatMap((paper) => (paper.layoutId ? [paper.layoutId] : []))),
    ]
    expect(expandedIds).toEqual(coverIds)
    expect(
      document
        .querySelector('[role="dialog"]')
        ?.querySelectorAll('button[aria-label^="打开便签："]')
    ).toHaveLength(7)
  })
  it("keeps all papers usable without spatial movement when reduced motion is requested", async () => {
    probe.reduced = true
    await act(async () => {
      root.render(<Collection />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    expect(probe.papers.length).toBeGreaterThanOrEqual(7)
    expect(
      probe.papers.every((paper) => !paper.layout && !paper.layoutId && paper.initial === false)
    ).toBe(true)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
