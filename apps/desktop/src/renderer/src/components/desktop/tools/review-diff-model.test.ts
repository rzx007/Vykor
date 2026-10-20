import { describe, expect, it } from "vitest"
import {
  createReviewDiffModel,
  findReviewMatches,
  reviewSelectionText,
  stepReviewIndex,
} from "./review-diff-model"

export const reviewPatch = [
  "diff --git a/old.ts b/new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -10,3 +10,4 @@",
  " same",
  "-old",
  "+new",
  "+added",
  " end",
  "@@ -50,2 +51,1 @@",
  "-removed",
  " tail",
  "",
].join("\n")
const source = {
  rootPath: "D:/repo",
  path: "new.ts",
  oldPath: "old.ts",
  range: "unstaged" as const,
}

describe("review diff context and navigation", () => {
  it("targets changed rows rather than leading context, including deletion-only changes", () => {
    const model = createReviewDiffModel(reviewPatch)!
    expect(model.changes.map(({ line, side }) => ({ line, side }))).toEqual([
      { line: 11, side: "additions" },
      { line: 50, side: "deletions" },
    ])
  })
  it("keeps the old-side path, line numbers, range and surrounding diff in copied context", () => {
    const text = reviewSelectionText(
      createReviewDiffModel(reviewPatch)!,
      { start: 11, end: 11, side: "deletions" },
      source
    )
    expect(text).toContain("old.ts:11")
    expect(text).toContain("未暂存")
    expect(text).toContain("旧版")
    expect(text).toContain("-old")
    expect(text).toContain("+new")
    expect(text).toContain("D:/repo")
  })
  it("supports mixed-side selections without mixing old and new line coordinates", () => {
    const text = reviewSelectionText(
      createReviewDiffModel(reviewPatch)!,
      { start: 11, side: "deletions", end: 12, endSide: "additions" },
      source
    )
    expect(text).toContain("旧版 11")
    expect(text).toContain("新版 12")
    expect(text).toContain("-old")
    expect(text).toContain("+added")
  })
  it.each([true, false])("preserves a missing final newline on the old side: %s", (oldSide) => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-foo",
      ...(oldSide ? ["\\ No newline at end of file"] : []),
      "+foo",
      ...(!oldSide ? ["\\ No newline at end of file"] : []),
      "",
    ].join("\n")
    const text = reviewSelectionText(
      createReviewDiffModel(patch)!,
      { start: 1, end: 1, side: "additions" },
      { ...source, path: "a.ts", oldPath: "a.ts" }
    )
    expect(text).toContain(
      oldSide
        ? "-foo\n\\ No newline at end of file\n+foo"
        : "-foo\n+foo\n\\ No newline at end of file"
    )
  })
  it("keeps omitted ranges explicit when a selection spans multiple hunks", () => {
    const text = reviewSelectionText(
      createReviewDiffModel(reviewPatch)!,
      { start: 11, end: 51, side: "deletions" },
      source
    )
    expect(text).toContain("@@ -10,3 +10,4 @@")
    expect(text).toContain("@@ -50,2 +51,1 @@")
    expect(text).toContain("-removed")
  })
  it("searches both versions and navigates cyclically", () => {
    const model = createReviewDiffModel(reviewPatch)!
    expect(findReviewMatches(model, "OLD").map(({ line, side }) => ({ line, side }))).toEqual([
      { line: 11, side: "deletions" },
    ])
    expect(stepReviewIndex(-1, 1, 2)).toBe(0)
    expect(stepReviewIndex(1, 1, 2)).toBe(0)
    expect(stepReviewIndex(-1, -1, 2)).toBe(1)
    expect(stepReviewIndex(0, 1, 0)).toBe(-1)
    expect(createReviewDiffModel("(no diff)")).toBeNull()
  })
})
