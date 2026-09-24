// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { RichPromptInput } from "../rich-prompt-input"
import { MessageBlock } from "../../message/message-block"
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $isElementNode,
  $createTextNode,
  getNearestEditorFromDOMNode,
  COPY_COMMAND,
  PASTE_COMMAND,
} from "lexical"
import { composerDocumentFromLexical, triggerFromEditorState } from "../rich-prompt-input"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"

let container: HTMLDivElement
let root: Root
const rangeBounds = Range.prototype.getBoundingClientRect
beforeEach(() => {
  vi.stubGlobal("ClipboardEvent", Event)
  if (!rangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  vi.unstubAllGlobals()
  if (!rangeBounds) Reflect.deleteProperty(Range.prototype, "getBoundingClientRect")
})
const command = {
  id: "compact",
  kind: "command" as const,
  label: "Compact",
  description: "",
  command: {
    id: "compact",
    title: "Compact",
    description: "",
    requiresEmptyComposer: true,
    selection: "execute" as const,
  },
}

it("copies and pastes structured references through the real composer clipboard handlers", async () => {
  const items: ComposerDocument["items"] = [
    { type: "text", text: "Use " },
    { type: "skill", name: "review", path: "D:/review/SKILL.md", displayName: "Review" },
    { type: "text", text: "\nthen " },
    { type: "mention", name: "resource", path: "app://resource", displayName: "Resource" },
  ];
  await act(async () => root.render(createElement(RichPromptInput, {
    id: "clipboard", value: { version: 1, items }, rows: 2, placeholder: "", disabled: false,
    skills: [{ name: "review", path: "D:/review/SKILL.md", displayName: "Review", description: "", sourceLabel: "个人" }],
    onChange: () => {}, onSubmit: () => {},
  })));
  const editor = getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!;
  const data = new Map<string, string>();
  const clipboardData = { files: [], getData: (type: string) => data.get(type) ?? "", setData: (type: string, value: string) => data.set(type, value) };
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  await act(async () => {
    editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true });
    editor.dispatchCommand(COPY_COMMAND, event as ClipboardEvent);
  });
  expect(data.get("application/x-vykor-composer")).toBeTruthy();
  expect(data.get("text/plain")).toContain("$review");
  await act(async () => {
    editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true });
    editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
  });
  expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual({ version: 1, items });

  data.delete("application/x-vykor-composer");
  data.set("text/plain", "$review plain");
  await act(async () => {
    editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true });
    editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
  });
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([{ type: "text", text: "$review plain" }]);

  data.set("application/x-vykor-composer", JSON.stringify({ version: 1, items: [{ type: "skill", name: "review", path: "D:/foreign/SKILL.md" }] }));
  data.set("text/plain", "$review");
  await act(async () => {
    editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true });
    editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
  });
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([{ type: "text", text: "$review" }]);
});

it.each(["body\n", "\nbody", "\n\n"])("keeps empty paragraphs when copying %j", async (text) => {
  await render({ version: 1, items: [{ type: "text", text }] });
  const editor = getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!;
  const data = new Map<string, string>();
  const event = new Event("copy", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData: (key: string, value: string) => data.set(key, value) } });
  await act(async () => {
    editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true });
    editor.dispatchCommand(COPY_COMMAND, event as ClipboardEvent);
  });
  expect(JSON.parse(data.get("application/x-vykor-composer")!).items).toEqual([{ type: "text", text }]);
});
async function render(
  value: ComposerDocument,
  onCommand = async () => {},
  onChange = (_: ComposerDocument) => {},
  skills = [
    {
      name: "review",
      path: "D:/review/SKILL.md",
      displayName: "Review",
      description: "",
      sourceLabel: "个人",
    },
  ]
) {
  await act(async () =>
    root.render(
      createElement(RichPromptInput, {
        id: "regression",
        value,
        rows: 2,
        placeholder: "",
        disabled: false,
        commands: [command],
        skills,
        onChange,
        onSubmit: () => {},
        onCommand,
      })
    )
  )
}
it("shows a command error and restores the slash draft", async () => {
  await render({ version: 1, items: [{ type: "text", text: "/compact" }] }, async () => {
    throw new Error("compact failed")
  })
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')
  expect(option).not.toBeNull()
  await act(async () => option!.click())
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe("/compact")
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("compact failed")
})
it("preserves resource mention metadata through editor updates", async () => {
  const value: ComposerDocument = {
    version: 1,
    items: [
      { type: "mention", name: "resource", path: "app://resource", displayName: "Resource" },
      { type: "text", text: " /" },
    ],
  }
  let latest = value
  await render(
    value,
    async () => {},
    (next) => {
      latest = next
    }
  )
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain("Resource")
  await act(async () => container.querySelector<HTMLElement>('[role="textbox"]')!.focus())
  expect(latest.items[0]).toEqual(value.items[0])
  const editor = getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!
  expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual(value)
  const serialized = editor.getEditorState().toJSON()
  await act(async () => editor.setEditorState(editor.parseEditorState(serialized)))
  expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual(value)
  expect(container.querySelector('[role="option"]')).toBeNull()
})

it.each(["/compact body", "/compact\nbody"])(
  "hides commands when the cursor returns to a leading token before body: %s",
  async (text) => {
    await render({ version: 1, items: [{ type: "text", text }] })
    const editor = getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!
    await act(async () =>
      editor.update(
        () => {
          const node = $getRoot().getFirstDescendant()
          if ($isTextNode(node)) node.select(8, 8)
        },
        { discrete: true }
      )
    )
    expect(container.querySelector('[role="option"]')).toBeNull()
    expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
      { type: "text", text },
    ])
  }
)

it("selects a Skill in the second paragraph and keeps the caret before the suffix", async () => {
  await act(async () =>
    root.render(
      createElement(RichPromptInput, {
        id: "paragraphs",
        value: { version: 1, items: [{ type: "text", text: "first\n/rev suffix" }] },
        rows: 2,
        placeholder: "",
        disabled: false,
        skills: [
          {
            name: "review",
            path: "D:/review/SKILL.md",
            displayName: "Review",
            description: "",
            sourceLabel: "个人",
          },
        ],
        onChange: () => {},
        onSubmit: () => {},
      })
    )
  )
  const editor = getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!
  await act(async () =>
    editor.update(
      () => {
        const node = $getRoot().getLastDescendant()
        if ($isTextNode(node)) node.select(4, 4)
      },
      { discrete: true }
    )
  )
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')
  expect(option?.textContent).toContain("Review")
  await act(async () => option!.click())
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    expect($isRangeSelection(selection)).toBe(true)
    if ($isRangeSelection(selection)) {
      expect(selection.anchor.offset).toBe(1)
      expect(selection.anchor.getNode().getTextContent()).toBe(" suffix")
    }
  })
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "text", text: "first\n" },
    { type: "skill", name: "review", path: "D:/review/SKILL.md", displayName: "Review" },
    { type: "text", text: " suffix" },
  ])
})

it("selects a Skill with Enter without creating a newline", async () => {
  const onSubmit = vi.fn()
  await render(
    { version: 1, items: [{ type: "text", text: "/rev suffix" }] },
    async () => {},
    () => {},
    [
      {
        name: "review",
        path: "D:/review/SKILL.md",
        displayName: "Review",
        description: "",
        sourceLabel: "个人",
      },
    ]
  )
  const editor = getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!
  await act(async () => {
    editor.update(() => {
      const node = $getRoot().getFirstDescendant()
      if ($isTextNode(node)) node.select(4, 4)
    }, { discrete: true })
  })
  expect(editor.getEditorState().read(triggerFromEditorState)).toMatchObject({ sigil: "/", query: "rev" })
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')
  expect(option?.textContent).toContain("Review")
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  })
  expect(onSubmit).not.toHaveBeenCalled()
  expect(editor.getEditorState().read(composerDocumentFromLexical).items).toEqual([
    { type: "skill", name: "review", path: "D:/review/SKILL.md", displayName: "Review" },
    { type: "text", text: " suffix" },
  ])
})

it("shows the Skill picker while IME composition contains slash text", async () => {
  await render({ version: 1, items: [] })
  const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!
  const editor = getNearestEditorFromDOMNode(textbox)!
  await act(async () => textbox.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })))
  await act(async () => {
    editor.update(() => {
      const paragraph = $getRoot().getFirstChild()
      const textNode = $createTextNode("/rev")
      if ($isElementNode(paragraph)) paragraph.append(textNode)
      textNode.selectEnd()
    }, { discrete: true })
  })
  expect(editor.getEditorState().read(triggerFromEditorState)).toMatchObject({ sigil: "/", query: "rev" })
  expect(container.querySelector('[role="option"]')?.textContent).toContain("Review")
})

it("edits the original structured message without flattening Skill or resource references", async () => {
  const items: ComposerDocument["items"] = [
    { type: "text", text: "Use " },
    {
      type: "skill",
      name: "review",
      path: "D:/review/SKILL.md",
      displayName: "Review",
      source: "user",
    },
    { type: "mention", name: "resource", path: "app://resource", displayName: "Resource" },
  ]
  let edited: ComposerDocument | undefined
  await act(async () =>
    root.render(
      createElement(MessageBlock, {
        message: {
          id: "m",
          sessionId: "s",
          seq: 1,
          role: "user",
          inputId: "i",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        parts: [
          {
            id: "p",
            sessionId: "s",
            messageId: "m",
            seq: 1,
            type: "text",
            status: "completed",
            text: "Use $review @resource",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        inputItems: items,
        streaming: false,
        userActions: {
          canEdit: true,
          onEdit: (document) => {
            edited = document
          },
        },
        onOpenFile: () => {},
        canOpenReview: false,
        onOpenReview: () => {},
        onOpenTerminal: () => {},
      })
    )
  )
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="重新编辑"]')!.click()
  )
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain("Review")
  await act(async () =>
    container
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  )
  expect(edited).toEqual({ version: 1, items })
})
