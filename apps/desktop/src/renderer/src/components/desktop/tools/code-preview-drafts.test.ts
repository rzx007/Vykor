import { beforeEach, describe, expect, it } from "vitest"
import { useCodePreviewDrafts } from "./code-preview-drafts"

beforeEach(() => useCodePreviewDrafts.setState({ drafts: {} }))
describe("code preview drafts", () => {
  it("keeps drafts independent across projects and preserves the disk baseline", () => {
    const store = useCodePreviewDrafts.getState()
    store.begin("project-a:file.ts", "old")
    store.change("project-a:file.ts", "draft")
    store.begin("project-a:file.ts", "external")
    store.begin("project-b:file.ts", "other")
    expect(useCodePreviewDrafts.getState().drafts["project-a:file.ts"]).toMatchObject({
      originalContent: "old",
      content: "draft",
      editing: true,
    })
    expect(useCodePreviewDrafts.getState().drafts["project-b:file.ts"]?.content).toBe("other")
  })
  it("marks only the saved snapshot clean when typing continues during a save", () => {
    const store = useCodePreviewDrafts.getState()
    store.begin("file", "old")
    store.change("file", "snapshot")
    store.change("file", "newer draft")
    store.saved("file", "snapshot")
    expect(useCodePreviewDrafts.getState().drafts.file).toMatchObject({
      originalContent: "snapshot",
      content: "newer draft",
      editing: true,
    })
    store.stop("file")
    expect(useCodePreviewDrafts.getState().drafts.file?.editing).toBe(false)
    expect(useCodePreviewDrafts.getState().drafts.file?.content).toBe("newer draft")
  })
  it("moves an editor and its pending save to the newly created conversation", () => {
    const from = JSON.stringify(["draft:project", "/project", "a.ts"])
    const to = JSON.stringify(["session:new", "/project", "a.ts"])
    const store = useCodePreviewDrafts.getState()
    store.begin(from, "old")
    store.change(from, "draft")
    const id = useCodePreviewDrafts.getState().drafts[from]!.id
    store.startSave(from)
    store.moveScope("draft:project", "session:new")
    expect(useCodePreviewDrafts.getState().drafts[from]).toBeUndefined()
    store.saved(from, "draft", id)
    store.finishSave(from, id)
    expect(useCodePreviewDrafts.getState().drafts[to]).toMatchObject({
      originalContent: "draft",
      content: "draft",
      editing: true,
      saving: false,
    })
    store.begin(from, "new chat")
    store.saved(from, "late reply", id)
    expect(useCodePreviewDrafts.getState().drafts[from]?.content).toBe("new chat")
    store.discard(to)
    store.saved(from, "reply after discard", id)
    expect(useCodePreviewDrafts.getState().drafts[from]?.originalContent).toBe("new chat")
  })
})
