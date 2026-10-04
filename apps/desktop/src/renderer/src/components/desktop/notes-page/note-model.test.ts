import type { DesktopNote } from "@shared/note-types"
import { describe, expect, it } from "vitest"

async function model() {
  const path = "./note-model"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    describeNote(content: string): { title: string; preview: string }
    filterAndSortNotes(notes: DesktopNote[], query: string): DesktopNote[]
  }
  expect(module).not.toBeNull()
  return module!
}

describe("note model", () => {
  it("derives a title and preview without storing either", async () => {
    const { describeNote } = await model()
    expect(describeNote("\n  First line  \n\n second   line\nthird")).toEqual({
      title: "First line",
      preview: "second line third",
    })
    expect(describeNote("   ")).toEqual({ title: "无标题便签", preview: "" })
  })

  it("caps derived text without changing source content", async () => {
    const { describeNote } = await model()
    const result = describeNote(`${"a".repeat(90)}\n${"b".repeat(130)}`)
    expect(result.title).toBe("a".repeat(80))
    expect(result.preview).toBe("b".repeat(120))
  })

  it("filters full content case-insensitively and sorts by updated time", async () => {
    const { filterAndSortNotes } = await model()
    const oldNote: DesktopNote = {
      id: "old",
      content: "other",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const newNote: DesktopNote = {
      id: "new",
      content: "contains BODY",
      revision: 1,
      createdAt: 2,
      updatedAt: 2,
    }
    expect(filterAndSortNotes([oldNote, newNote], "body").map((note) => note.id)).toEqual(["new"])
    expect(filterAndSortNotes([oldNote, newNote], "").map((note) => note.id)).toEqual([
      "new",
      "old",
    ])
  })
})
