import { expect, it } from "vitest"
import type { SessionUserInputItem } from "@shared/session-types"
import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import { formatBrowserAnnotationContext, readBrowserAnnotationContext, stripBrowserAnnotationContext } from "../browser-annotation-context"

const savedContext = '\n\n<browser_annotations>\n{"url":"http://localhost/design","annotations":[{"target":"按钮","selector":"#submit","comment":"增加留白"}]}\n</browser_annotations>'

it.each([true, false])("removes only the saved trailing block without mutating message items (merged=%s)", merged => {
  const original: SessionUserInputItem[] = merged
    ? [{ type: "text", text: `按批注修改${savedContext}` }]
    : [{ type: "text", text: "按批注修改" }, { type: "text", text: savedContext }]
  const before = structuredClone(original)
  expect(stripBrowserAnnotationContext(original)).toEqual([{ type: "text", text: "按批注修改" }])
  expect(original).toEqual(before)
})

it.each([
  `${savedContext}\n用户补充`,
  '\n\n<browser_annotations>\nnot json\n</browser_annotations>',
  '\n\n<browser_annotations>\n{"url":123,"annotations":[]}\n</browser_annotations>',
  '\n\n<browser_annotations>\n{"url":"http://localhost","annotations":{}}\n</browser_annotations>',
])("preserves text that is not a valid saved trailing context block: %s", text => {
  const items: SessionUserInputItem[] = [{ type: "text", text }]
  expect(stripBrowserAnnotationContext(items)).toEqual(items)
})

it("preserves annotation-looking text before a final non-text item", () => {
  const items: SessionUserInputItem[] = [
    { type: "text", text: savedContext }, { type: "mention", name: "file", path: "file.ts" },
  ]
  expect(stripBrowserAnnotationContext(items)).toEqual(items)
})

it("removes the original automatic block after the edit appends text and a mention", () => {
  const source: SessionUserInputItem[] = [{ type: "text", text: `原正文${savedContext}` }]
  const edited: SessionUserInputItem[] = [
    { type: "text", text: `新正文${savedContext}\n补充：保留图标` },
    { type: "mention", name: "file", path: "file.ts" },
  ]
  const beforeSource = structuredClone(source), beforeEdited = structuredClone(edited)
  expect(stripBrowserAnnotationContext(edited, source)).toEqual([
    { type: "text", text: "新正文\n补充：保留图标" },
    { type: "mention", name: "file", path: "file.ts" },
  ])
  expect(source).toEqual(beforeSource)
  expect(edited).toEqual(beforeEdited)
})

it("removes the exact source block only once, searching text items from the end", () => {
  const source: SessionUserInputItem[] = [{ type: "text", text: savedContext }]
  const edited: SessionUserInputItem[] = [
    { type: "text", text: `引用${savedContext}\n引用结束` },
    { type: "mention", name: "file", path: "file.ts" },
    { type: "text", text: savedContext },
    { type: "text", text: "新增要求" },
  ]
  expect(stripBrowserAnnotationContext(edited, source)).toEqual([
    { type: "text", text: `引用${savedContext}\n引用结束` },
    { type: "mention", name: "file", path: "file.ts" },
    { type: "text", text: "新增要求" },
  ])
})

it.each([
  "原正文",
  `原正文${savedContext}\n原消息自己的补充`,
  '\n\n<browser_annotations>\nnot json\n</browser_annotations>',
])("preserves a handwritten middle block when the source has no valid automatic suffix: %s", sourceText => {
  const edited: SessionUserInputItem[] = [{ type: "text", text: `正文${savedContext}\n补充` }]
  expect(stripBrowserAnnotationContext(edited, [{ type: "text", text: sourceText }])).toEqual(edited)
})

it("keeps the strict trailing-block fallback when the source has no automatic context", () => {
  const edited: SessionUserInputItem[] = [{ type: "text", text: `正文${savedContext}` }]
  expect(stripBrowserAnnotationContext(edited, [{ type: "text", text: "原正文" }])).toEqual([
    { type: "text", text: "正文" },
  ])
})

it("reads legacy annotation snapshots with the user text kept separate", () => {
  expect(readBrowserAnnotationContext(`修改页面${savedContext}`)).toEqual({
    text: "修改页面",
    url: "http://localhost/design",
    annotations: [{ target: "按钮", selector: "#submit", comment: "增加留白" }],
  })
})

it("keeps optional annotation identity and page information in newer snapshots", () => {
  const text = '\n\n<browser_annotations>\n{"url":"http://localhost/design","annotations":[{"id":"a-1","pageUrl":"http://localhost/other","tagName":"button","target":"按钮","selector":"#submit","comment":"增加留白"}]}\n</browser_annotations>'
  expect(readBrowserAnnotationContext(text)).toEqual({
    text: "",
    url: "http://localhost/design",
    annotations: [{ id: "a-1", pageUrl: "http://localhost/other", tagName: "button", target: "按钮", selector: "#submit", comment: "增加留白" }],
  })
})

it.each([
  "not json",
  '{"url":123,"annotations":[]}',
  '{"url":"http://localhost","annotations":[null]}',
  '{"url":"http://localhost","annotations":[{"target":"按钮","comment":"意见"}]}',
  '{"url":"http://localhost","annotations":[{"target":"按钮","selector":"#submit","comment":123}]}',
  '{"url":"http://localhost","annotations":[{"target":"按钮","selector":"#submit","comment":"意见","pageUrl":123}]}',
])("does not hide invalid annotation snapshots: %s", json => {
  const text = `正文\n\n<browser_annotations>\n${json}\n</browser_annotations>`
  expect(readBrowserAnnotationContext(text)).toBeNull()
  expect(stripBrowserAnnotationContext([{ type: "text", text }])).toEqual([{ type: "text", text }])
})

it("only reads complete snapshots at the very end of user input", () => {
  expect(readBrowserAnnotationContext(`正文${savedContext}\n后文`)).toBeNull()
  expect(readBrowserAnnotationContext(savedContext.slice(0, -1))).toBeNull()
})

it("formats multiple page annotations with identity and safely escaped comments", () => {
  const pageUrl = "http://localhost:5173/design"
  const first: BrowserAnnotationRecord = {
    id: "a-1", pageUrl, tagName: "button", target: "button: 提交", selector: "#submit",
    comment: "增加按钮留白", locatorKind: "unique-id", role: "button", name: "提交",
  }
  const text = formatBrowserAnnotationContext([
    first,
    { ...first, id: "a-2", pageUrl: "http://localhost/other", comment: "保留 <button>" },
  ])!
  expect(text).toContain("\\u003cbutton>")
  expect(readBrowserAnnotationContext(text)).toEqual({
    text: "",
    url: pageUrl,
    annotations: [
      { id: "a-1", pageUrl, tagName: "button", target: "button: 提交", selector: "#submit", comment: "增加按钮留白" },
      { id: "a-2", pageUrl: "http://localhost/other", tagName: "button", target: "button: 提交", selector: "#submit", comment: "保留 <button>" },
    ],
  })
  expect(formatBrowserAnnotationContext([])).toBeNull()
})
