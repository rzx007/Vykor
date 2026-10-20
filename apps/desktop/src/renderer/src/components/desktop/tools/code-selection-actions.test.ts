// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { codeSelectionText, type CodeSelectionContext } from "./code-selection-context"
import { addCodeSelectionToComposer, createCodeSelectionAction } from "./code-selection-actions"

const state = vi.hoisted(() => ({
  activeSessionId: "chat",
  composerDraftsByScope: {} as Record<string, unknown>,
  setComposerDraftDocument: vi.fn(),
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: { getState: () => state },
}))
const selection: CodeSelectionContext = {
  path: "src/main.ts",
  language: "typescript",
  startLine: 3,
  endLine: 5,
  startColumn: 2,
  endColumn: 8,
  text: "const 名称 = `value`",
  unsaved: true,
}
beforeEach(() => {
  state.activeSessionId = "chat"
  state.composerDraftsByScope = {
    "session:chat": {
      document: composerDocument([{ type: "text", text: "已有问题" }]),
      attachments: [{ draftId: "keep" }],
    },
  }
  state.setComposerDraftDocument.mockClear()
  window.desktop = { clipboard: { writeText: vi.fn(async () => {}) } } as never
})

describe("code selection context", () => {
  it("appends code with file, line/column and unsaved metadata without overwriting the draft", () => {
    addCodeSelectionToComposer("session:chat", selection)
    const [scope, document] = state.setComposerDraftDocument.mock.calls[0]!
    expect(scope).toBe("session:chat")
    expect(document.items[0].text).toContain("已有问题")
    expect(document.items[0].text).toContain("src/main.ts:3:2-5:8（未保存的编辑内容）")
    expect(document.items[0].text).toContain("```typescript\nconst 名称 = `value`\n```")
    expect(state.composerDraftsByScope["session:chat"]).toHaveProperty("attachments", [
      { draftId: "keep" },
    ])
  })
  it("does not add code from a stale chat to the newly active chat", () => {
    state.activeSessionId = "other"
    expect(() => addCodeSelectionToComposer("session:chat", selection)).toThrow("当前聊天已变化")
    expect(state.setComposerDraftDocument).not.toHaveBeenCalled()
  })
  it("uses a longer fence for selected Markdown containing code fences", () => {
    const text = codeSelectionText({ ...selection, text: "```ts\ncode\n```" })
    expect(text).toContain("````typescript\n```ts\ncode\n```\n````")
  })
  it("reads the current selection when an action is clicked", async () => {
    const context = {
      selection: { start: { line: 2, character: 1 }, end: { line: 4, character: 7 } },
      getSelectionText: () => "latest selection",
      close: vi.fn(),
    }
    const render = createCodeSelectionAction({
      scopeId: "session:chat",
      path: "a.ts",
      language: "ts",
      isUnsaved: () => false,
    })
    const toolbar = render(context as never)
    toolbar.querySelector<HTMLButtonElement>("button")!.click()
    await vi.waitFor(() => expect(context.close).toHaveBeenCalled())
    expect(state.setComposerDraftDocument.mock.calls[0]![1].items[0].text).toContain(
      "latest selection"
    )
  })
  it("leaves focus in the composer after the library closes its selection popover", async () => {
    const editor = document.createElement("textarea")
    const composer = document.createElement("textarea")
    composer.id = "message-composer"
    document.body.append(editor, composer)
    try {
      const context = {
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        getSelectionText: () => "code",
        close: vi.fn(() => editor.focus()),
      }
      const toolbar = createCodeSelectionAction({
        scopeId: "session:chat",
        path: "a.ts",
        language: "ts",
        isUnsaved: () => false,
      })(context as never)
      toolbar.querySelector<HTMLButtonElement>("button")!.click()
      await vi.waitFor(() => expect(context.close).toHaveBeenCalled())
      expect(document.activeElement).toBe(composer)
    } finally {
      editor.remove()
      composer.remove()
    }
  })
})
