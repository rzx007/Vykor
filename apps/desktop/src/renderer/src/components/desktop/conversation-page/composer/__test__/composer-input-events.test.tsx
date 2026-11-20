// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  CUT_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  getNearestEditorFromDOMNode,
} from "lexical"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { RichPromptInput, composerDocumentFromLexical } from "../rich-prompt-input"
import type { ContextPickerItem } from "../context-picker"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"

let container: HTMLDivElement
let root: Root
const rangeBounds = Range.prototype.getBoundingClientRect

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  if (!rangeBounds) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
  }
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  if (!rangeBounds) Reflect.deleteProperty(Range.prototype, "getBoundingClientRect")
})

async function renderInput(
  text: string,
  props: Partial<ComponentProps<typeof RichPromptInput>> = {}
) {
  await act(async () =>
    root.render(
      createElement(RichPromptInput, {
        id: "input-events",
        value: { version: 1, items: [{ type: "text", text }] },
        rows: 2,
        placeholder: "",
        disabled: false,
        onChange: () => {},
        onSubmit: () => {},
        ...props,
      })
    )
  )
  const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!
  return { textbox, editor: getNearestEditorFromDOMNode(textbox)! }
}

const compositionKeys = [
  { name: "native composition flag", isComposing: true },
  { name: "IME key code after composition ends", keyCode: 229 },
]

it("submits ordinary Enter and keeps Shift+Enter as a newline", async () => {
  const onSubmit = vi.fn()
  const { textbox, editor } = await renderInput("你好", { onSubmit })
  await act(async () =>
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(onSubmit).not.toHaveBeenCalled()
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "你好\n" },
  ])

  await act(async () =>
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(onSubmit).toHaveBeenCalledTimes(1)
})

it.each(compositionKeys)("keeps Enter for the input method with $name", async (key) => {
  const onSubmit = vi.fn()
  const { textbox, editor } = await renderInput("你好", { onSubmit })
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...key,
  })

  await act(async () => textbox.dispatchEvent(event))

  expect(onSubmit).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "你好" },
  ])
})

it.each(compositionKeys)("does not select a Skill with $name", async (key) => {
  const { textbox, editor } = await renderInput("/rev", {
    skills: [
      {
        name: "review",
        path: "D:/review/SKILL.md",
        displayName: "Review",
        description: "",
        sourceLabel: "个人",
      },
    ],
  })
  expect(container.querySelector('[role="option"]')?.textContent).toContain("Review")
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...key,
  })

  await act(async () => textbox.dispatchEvent(event))

  expect(event.defaultPrevented).toBe(false)
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "/rev" },
  ])
})

it.each(compositionKeys)("does not select a context with $name", async (key) => {
  const { textbox, editor } = await renderInput("@历史", {
    contextItems: [
      {
        id: "history",
        label: "历史对话",
        description: "",
        group: "对话",
        action: { kind: "conversation", sessionId: "previous", displayName: "历史对话" },
      },
    ],
  })
  expect(container.querySelector('[role="option"]')?.textContent).toContain("历史对话")
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...key,
  })

  await act(async () => textbox.dispatchEvent(event))

  expect(event.defaultPrevented).toBe(false)
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "@历史" },
  ])
})

const observationItems: ContextPickerItem[] = [
  {
    id: "build",
    label: "构建桌面版",
    description: "引用历史对话",
    group: "历史对话",
    observation: { priority: 1, workspace: "D:/build", status: "执行中", updatedAt: 1 },
    action: { kind: "conversation", sessionId: "build", displayName: "构建桌面版" },
  },
  {
    id: "observe-mode",
    label: "观察进度",
    description: "选择要观察的会话",
    group: "添加",
    action: { kind: "observe-mode" },
  },
]

it("inserts the directive before a draft beginning with a history reference and undoes it as one edit", async () => {
  const items: ComposerDocument["items"] = [
    { type: "context", kind: "conversation", id: "previous", displayName: "历史对话" },
    { type: "text", text: " 请看看 @构建" },
  ]
  const onSubmit = vi.fn()
  const { textbox, editor } = await renderInput("", {
    value: { version: 1, items },
    contextItems: observationItems,
    onSubmit,
  })
  const key = (key: string, options: KeyboardEventInit = {}) =>
    act(async () => textbox.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...options,
    })))
  await key("ArrowUp")
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("观察进度")
  await key("Enter", { isComposing: true })
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("观察进度")
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual(items)

  await key("Enter")
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("构建桌面版")
  await key("Enter")
  expect(onSubmit).not.toHaveBeenCalled()
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "observe-session build\n" },
    items[0],
    { type: "text", text: " 请看看 " },
  ])
  await act(async () => editor.dispatchCommand(UNDO_COMMAND, undefined))
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual(items)
})

it("keeps an existing directive when dismissing and replaces it when selecting a new target", async () => {
  const original = "observe-session previous\n继续 @构建"
  const { textbox, editor } = await renderInput(original, { contextItems: observationItems })
  const option = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((button) => button.textContent?.includes(label))
  await act(async () => option("观察进度")?.click())
  await act(async () => textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([{ type: "text", text: original }])

  await act(async () => editor.update(() => {
    const text = $getRoot().getLastDescendant()
    text?.selectEnd()
    $getSelection()?.insertText("桌面")
  }, { discrete: true }))
  expect(option("构建桌面版")?.textContent).toContain("引用历史对话")
  await act(async () => option("观察进度")?.click())
  await act(async () => option("构建桌面版")?.click())
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "observe-session build\n继续 " },
  ])
})

it("keeps the default @ action as a structured history reference", async () => {
  const { textbox, editor } = await renderInput("@构建", { contextItems: observationItems })
  await act(async () => textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "context", kind: "conversation", id: "build", displayName: "构建桌面版" },
    { type: "text", text: " " },
  ])
})

it("preserves a dismissed @ query when observing from + and leaves the picker closed", async () => {
  const props = { contextItems: observationItems }
  const text = "看看 @构建"
  const { textbox, editor } = await renderInput(text, props)
  await act(async () => textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  await renderInput(text, { ...props, contextPickerRequest: 1, contextPickerOpen: true })
  const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  await act(async () => options().at(-1)?.click())
  await act(async () => options()[0]?.click())
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "observe-session build\n看看 @构建" },
  ])
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})

it("puts the caret at the start of the body when replacing the directive under it", async () => {
  const text = "observe-session long-previous-target\n看看结果"
  const { editor } = await renderInput(text, { contextItems: observationItems })
  await act(async () => editor.update(() => {
    const first = $getRoot().getFirstDescendant()
    if ($isTextNode(first)) first.select(30, 30)
  }, { discrete: true }))
  await renderInput(text, { contextItems: observationItems, contextPickerRequest: 1, contextPickerOpen: true })
  const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  await act(async () => options().at(-1)?.click())
  await act(async () => options()[0]?.click())
  await act(async () => editor.update(() => $getSelection()?.insertText("先"), { discrete: true }))
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "observe-session build\n先看看结果" },
  ])
})

function clipboardEvent(type: "paste" | "cut", values: ReadonlyMap<string, string>) {
  const copied = new Map<string, string>()
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (key: string) => values.get(key) ?? "",
      setData: (key: string, value: string) => copied.set(key, value),
    },
  })
  return { event: event as ClipboardEvent, copied }
}

it.each(["keyboard", "paste"])(
  "blocks %s after a focused input becomes disabled and restores editing when enabled",
  async (kind) => {
    const { textbox, editor } = await renderInput("draft")
    await act(async () => {
      textbox.focus()
      editor.update(() => $getRoot().selectEnd(), { discrete: true })
    })
    expect(document.activeElement).toBe(textbox)
    const disabled = await renderInput("draft", { disabled: true })
    expect(disabled.editor).toBe(editor)
    const edit = () => {
      const event =
        kind === "keyboard"
          ? new KeyboardEvent("keydown", {
              key: "Enter",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            })
          : clipboardEvent("paste", new Map([["text/plain", " added"]])).event
      textbox.dispatchEvent(event)
    }

    await act(async () => edit())

    expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
      { type: "text", text: "draft" },
    ])
    expect(editor.isEditable()).toBe(false)

    const enabled = await renderInput("draft", { disabled: false })
    expect(enabled.editor).toBe(editor)
    await act(async () => {
      textbox.focus()
      editor.update(() => $getRoot().selectEnd(), { discrete: true })
      edit()
    })
    expect(editor.isEditable()).toBe(true)
    expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
      { type: "text", text: kind === "keyboard" ? "draft\n" : "draft added" },
    ])
  }
)

it("blocks an already open picker while disabled and restores it when enabled", async () => {
  const skills = [
    {
      name: "review",
      path: "D:/review/SKILL.md",
      displayName: "Review",
      description: "",
      sourceLabel: "个人",
    },
  ]
  const { textbox, editor } = await renderInput("/rev", { skills })
  await act(async () => {
    textbox.focus()
    editor.update(() => $getRoot().selectEnd(), { discrete: true })
  })
  expect(container.querySelector('[role="option"]')).not.toBeNull()
  await renderInput("/rev", { skills, disabled: true })

  await act(async () =>
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      })
    )
  )

  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "/rev" },
  ])
  expect(container.querySelector('[role="option"]')).toBeNull()

  await renderInput("/rev", { skills, disabled: false })
  await act(async () =>
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "skill", name: "review", path: "D:/review/SKILL.md", displayName: "Review" },
    { type: "text", text: " " },
  ])
})

it.each(["body\n", "\nbody", "\n\n", "a\n\nb"])(
  "preserves empty paragraphs when pasting structured text %j",
  async (text) => {
    const { editor } = await renderInput("replace me")
    const { event } = clipboardEvent(
      "paste",
      new Map([
        [
          "application/x-vykor-composer",
          JSON.stringify({
            version: 1,
            items: [{ type: "text", text }],
          }),
        ],
        ["text/plain", text],
      ])
    )

    await act(async () => {
      editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true })
      editor.dispatchCommand(PASTE_COMMAND, event)
    })

    expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
      { type: "text", text },
    ])
  }
)

it("cuts selected references and restores them with undo and redo", async () => {
  const items: ComposerDocument["items"] = [
    { type: "text", text: "Use " },
    { type: "skill", name: "review", path: "D:/review/SKILL.md", displayName: "Review" },
    { type: "text", text: " and " },
    { type: "context", kind: "conversation", id: "previous", displayName: "历史对话" },
    { type: "text", text: " after" },
  ]
  const { editor } = await renderInput("", { value: { version: 1, items } })
  const { event, copied } = clipboardEvent("cut", new Map())
  await act(async () => {
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild()
        if ($isElementNode(paragraph)) paragraph.select(1, 3)
      },
      { discrete: true }
    )
    editor.dispatchCommand(CUT_COMMAND, event)
  })

  expect(copied.get("text/plain")).toBe("$review and ")
  expect(JSON.parse(copied.get("application/x-vykor-composer")!)).toEqual({
    version: 1,
    items: [
      { type: "skill", name: "review", path: "D:/review/SKILL.md", displayName: "Review" },
      { type: "text", text: " and " },
    ],
  })
  const cutItems = [
    { type: "text", text: "Use " },
    { type: "context", kind: "conversation", id: "previous", displayName: "历史对话" },
    { type: "text", text: " after" },
  ]
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual(cutItems)

  await act(async () => editor.dispatchCommand(UNDO_COMMAND, undefined))
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual(items)
  await act(async () => editor.dispatchCommand(REDO_COMMAND, undefined))
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual(cutItems)
})

it("routes a long plain-text paste to an attachment while preserving the draft", async () => {
  const onPasteTextAttachment = vi.fn()
  const { editor } = await renderInput("keep this", { onPasteTextAttachment })
  const text = "日志\n".repeat(2_000)
  const { event } = clipboardEvent("paste", new Map([["text/plain", text]]))

  await act(async () => editor.dispatchCommand(PASTE_COMMAND, event))

  expect(onPasteTextAttachment).toHaveBeenCalledExactlyOnceWith(text)
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "keep this" },
  ])
})

it("keeps references when pasting a long structured draft instead of making a text attachment", async () => {
  const onPasteTextAttachment = vi.fn()
  const { editor } = await renderInput("", { onPasteTextAttachment })
  const text = "正文".repeat(2_500)
  const items: ComposerDocument["items"] = [
    { type: "text", text },
    {
      type: "capability",
      kind: "plugin_agent",
      pluginId: "dev.quality",
      agentId: "review",
      displayName: "代码审查",
    },
  ]
  const { event } = clipboardEvent(
    "paste",
    new Map([
      ["text/plain", `${text}@代码审查`],
      ["application/x-vykor-composer", JSON.stringify({ version: 1, items })],
    ])
  )

  await act(async () => editor.dispatchCommand(PASTE_COMMAND, event))

  expect(onPasteTextAttachment).not.toHaveBeenCalled()
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual(items)
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    expect($isRangeSelection(selection) && selection.isCollapsed()).toBe(true)
  })
})
