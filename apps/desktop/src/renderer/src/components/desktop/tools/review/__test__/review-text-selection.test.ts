// @vitest-environment jsdom
import { expect, it } from "vitest"
import { readReviewTextSelection } from "../review-text-selection"

it("maps native code text selection to its old/new sides and actual line numbers", () => {
  const host = document.createElement("div"),
    root = host.attachShadow({ mode: "open" })
  root.innerHTML =
    '<code data-deletions><span data-line="11" data-line-type="change-deletion">old text</span></code><code data-additions><span data-line="12" data-line-type="change-addition">new text</span></code>'
  const first = root.querySelector('[data-line="11"]')!.firstChild!,
    last = root.querySelector('[data-line="12"]')!.firstChild!
  const range = document.createRange()
  range.setStart(first, 0)
  range.setEnd(last, 3)
  Object.defineProperty(root, "getSelection", {
    value: () => ({ rangeCount: 1, toString: () => "old text new", getRangeAt: () => range }),
  })
  expect(readReviewTextSelection(root)).toEqual({
    start: 11,
    end: 12,
    side: "deletions",
    endSide: "additions",
  })
})
it("ignores selections from outside this diff", () => {
  const root = document.createElement("div")
  expect(readReviewTextSelection(root)).toBeNull()
})
