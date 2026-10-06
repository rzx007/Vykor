// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { NOTE_APPEARANCE_KEY, readNoteAppearances } from "./note-appearance"

afterEach(() => localStorage.clear())

it.each(["clay", "lilac"])("restores the %s paper color after reopening", (color) => {
  localStorage.setItem(NOTE_APPEARANCE_KEY, JSON.stringify({ paper: { pinned: false, color } }))
  expect(readNoteAppearances(localStorage)).toEqual({ paper: { pinned: false, color } })
})

it("preserves the original paper and existing rose markings alongside the new colors", () => {
  localStorage.setItem(
    NOTE_APPEARANCE_KEY,
    JSON.stringify({
      original: { pinned: false, color: "default" },
      existing: { pinned: true, color: "rose" },
    })
  )
  expect(readNoteAppearances(localStorage)).toEqual({
    original: { pinned: false, color: "default" },
    existing: { pinned: true, color: "rose" },
  })
})
