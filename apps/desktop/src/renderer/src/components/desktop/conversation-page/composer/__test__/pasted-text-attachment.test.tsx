import { businessDataFixture } from "@renderer/lib/__test__/business-data-fixture"
// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { getNearestEditorFromDOMNode, PASTE_COMMAND } from "lexical"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session/store"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"
import { emptyComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import { Composer } from "../composer"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))

let container: HTMLDivElement
let root: Root
const scope = "session:pasted"
const text = "  一段长文本\n".repeat(800)

function TestComposer({
  readOnly = false,
  sending = false,
}: {
  readOnly?: boolean
  sending?: boolean
}) {
  const draft = useDesktopSessionStore((state) => state.composerDraftsByScope[scope])
  return createElement(Composer, {
    id: "paste-composer",
    composerScope: scope,
    draft: draft?.document ?? emptyComposerDocument,
    attachments: draft?.attachments,
    attachmentReadOnly: readOnly,
    attachmentInteractionEnabled: true,
    onPasteTextAttachment: (value) =>
      useDesktopSessionStore.getState().addPastedTextAttachment(scope, value),
    sending,
    models: [],
    selectedModel: null,
    selectedProvider: null,
    modelLabel: "模型",
    permissionMode: "ask",
    effort: null,
    onDraftChange: (value) =>
      useDesktopSessionStore.getState().setComposerDraftDocument(scope, value),
    onSubmit: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectPermissionMode: vi.fn(),
    onSelectEffort: vi.fn(),
  })
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  resetDesktopSessionStore()
  Object.assign(window, {
    desktop: { businessData: businessDataFixture,
      attachments: {
        uploadClipboardImage: vi.fn().mockResolvedValue(undefined),
        cancelUpload: vi.fn().mockResolvedValue(undefined),
      },
    },
  })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("shows pasted text in the editable composer and focuses it without creating another attachment", async () => {
  const store = useDesktopSessionStore.getState()
  store.setComposerDraftText(scope, "已有正文")
  await act(async () => root.render(createElement(TestComposer, {})))
  const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  })
  await act(async () =>
    getNearestEditorFromDOMNode(textbox)!.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent)
  )
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("在文本框中显示")
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
  expect(textbox.textContent).toContain("已有正文")
  expect(textbox.textContent).toContain("一段长文本")
  expect(document.activeElement).toBe(textbox)
  expect(container.querySelector('[data-display="file-card"]')).toBeNull()
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments).toEqual([])
  expect(window.desktop.attachments.uploadClipboardImage).toHaveBeenCalledOnce()
})

it.each([
  { label: "read only", readOnly: true },
  { label: "sending", sending: true },
])("hides conversion when the composer is $label", async (props) => {
  await useDesktopSessionStore.getState().addPastedTextAttachment(scope, text)
  await act(async () =>
    root.render(createElement(TestComposer, { readOnly: props.readOnly, sending: props.sending }))
  )
  expect(container.textContent).not.toContain("在文本框中显示")
})
