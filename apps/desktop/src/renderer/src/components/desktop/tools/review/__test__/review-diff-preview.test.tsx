// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { FileDiffOptions } from "@pierre/diffs"
import { pluckInteractionOptions } from "@pierre/diffs"
import type { ReactNode } from "react"
import { ReviewDiffPreview } from "../review-diff-preview"
import type { ReviewSelectionSource } from "../review-diff-model"

const calls = vi.hoisted(() => ({
  options: null as FileDiffOptions<undefined, undefined> | null,
  customGutter: false,
  add: vi.fn(),
}))
vi.mock("../../code-context/code-selection-actions", () => ({ addTextToComposer: calls.add }))
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    options,
    renderGutterUtility,
  }: {
    options: FileDiffOptions<undefined, undefined>
    renderGutterUtility?: (
      getHoveredLine: () => { lineNumber: number; side: "additions" }
    ) => ReactNode
  }) => {
    calls.options = options
    calls.customGutter = !!renderGutterUtility
    return (
      <div data-test-diff>
        {renderGutterUtility?.(() => ({ lineNumber: 12, side: "additions" }))}
      </div>
    )
  },
}))
const patch = [
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
let root: Root, container: HTMLDivElement
const open = vi.fn()
const preview = (range: ReviewSelectionSource["range"] = "unstaged") => (
  <ReviewDiffPreview
    file={{
      path: "new.ts",
      oldPath: "old.ts",
      status: "renamed",
      additions: 2,
      deletions: 2,
      binary: false,
    }}
    patch={patch}
    themeType="light"
    diffViewMode="split"
    baseOptions={{}}
    source={{ scopeId: "session:chat", rootPath: "D:/repo", range }}
    onOpenFile={open}
  />
)
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  calls.add.mockReset()
  open.mockReset()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(preview()))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!

it("uses a gutter configuration accepted by the actual Pierre interaction manager", () => {
  expect(() =>
    pluckInteractionOptions({
      ...calls.options!,
      renderGutterUtility: calls.customGutter ? () => null : undefined,
    })
  ).not.toThrow()
})
it("adds a hovered line exactly once for pointer and keyboard gutter activation", async () => {
  const gutter = container.querySelector<HTMLButtonElement>("[data-test-diff] button")!
  await act(async () => gutter.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })))
  expect(calls.add).toHaveBeenCalledTimes(1)
  expect(calls.add.mock.calls[0]![1]).toContain("new.ts:12")
  await act(async () => gutter.click())
  expect(calls.add).toHaveBeenCalledTimes(2)
})

it("opens staged files without treating index line numbers as working tree line numbers", async () => {
  await act(async () => root.render(preview("staged")))
  await act(async () => button("下一处改动").click())
  await act(async () => button("打开源码").click())
  expect(open).toHaveBeenCalledWith("D:/repo/new.ts", undefined)
})

it("adds an old-side selection with version metadata to the existing composer entry point", async () => {
  await act(async () =>
    calls.options!.onLineSelectionEnd!({ start: 11, end: 11, side: "deletions" })
  )
  await act(async () => button("添加选区到输入框").click())
  expect(calls.add).toHaveBeenCalledWith("session:chat", expect.stringContaining("old.ts:11"))
  expect(calls.add.mock.calls[0]![1]).toContain("旧版")
  expect(calls.add.mock.calls[0]![1]).toContain("未暂存")
  expect(calls.add.mock.calls[0]![1]).toContain("-old")
})
it("navigates actual changes and opens only a valid new-side source line", async () => {
  await act(async () => button("下一处改动").click())
  expect(container.textContent).toContain("1/2")
  await act(async () => button("打开源码").click())
  expect(open).toHaveBeenCalledWith("D:/repo/new.ts", 11)
  await act(async () => button("下一处改动").click())
  expect(container.textContent).toContain("2/2")
  expect(button("打开源码").disabled).toBe(true)
})

it("finds code in either version and returns keyboard focus when search closes", async () => {
  await act(async () => button("查找差异").click())
  const input = container.querySelector<HTMLInputElement>('[aria-label="搜索差异"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "added")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => button("打开源码").click())
  expect(open).toHaveBeenLastCalledWith("D:/repo/new.ts", 12)
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  )
  expect(container.querySelector('[aria-label="搜索差异"]')).toBeNull()
  expect(document.activeElement).toBe(container.querySelector('[aria-label="文件差异"]'))
})
