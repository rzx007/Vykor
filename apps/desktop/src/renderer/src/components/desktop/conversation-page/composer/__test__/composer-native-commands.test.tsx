// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { Composer } from "../composer"
import type { ComposerPickerItem } from "../composer-picker"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session/store"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import type { DesktopSessionActivity } from "@shared/activity-types"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}))

let root: Root
let container: HTMLDivElement
const onCommand = vi.fn(async () => {})
const onSubmit = vi.fn()
const onSelectModel = vi.fn()
const onSelectEffort = vi.fn()
const models = [
  {
    id: "test-model",
    label: "测试模型",
    provider: "本地",
    providerName: "local",
    reasoningEfforts: ["low", "high"],
  },
  { id: "other-model", label: "另一个模型", provider: "本地", providerName: "local" },
]

it("does not carry an unfinished annotation edit into another composer scope", async () => {
  const state = useDesktopSessionStore.getState()
  const previousDrafts = state.composerDraftsByScope
  const record: BrowserAnnotationRecord = {
    id: "shared-annotation",
    pageUrl: "https://example.test",
    target: "提交",
    selector: "#submit",
    locatorKind: "unique-id",
    tagName: "button",
    role: "button",
    name: "提交",
    comment: "第一份意见",
  }
  state.putBrowserAnnotation("session:annotation-a", record)
  state.putBrowserAnnotation("session:annotation-b", { ...record, comment: "第二份意见" })
  async function renderScope(scope: string) {
    await act(async () =>
      root.render(
        <Composer
          id={`native-${scope}`}
          composerScope={scope}
          draft={composerDocument([])}
          sending={false}
          models={models}
          selectedModel="test-model"
          selectedProvider="local"
          modelLabel="测试模型"
          permissionMode="ask"
          effort={null}
          onDraftChange={vi.fn()}
          onSubmit={onSubmit}
          onSelectModel={onSelectModel}
          onSelectPermissionMode={vi.fn()}
          onSelectEffort={onSelectEffort}
        />
      )
    )
  }
  try {
    await renderScope("session:annotation-a")
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("条批注")
    )!
    await act(async () => trigger.click())
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="编辑批注 1"]')!.click()
    )
    const textarea = document.querySelector("textarea")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "尚未保存的第一份意见"
      )
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await renderScope("session:annotation-b")
    expect(document.querySelector("textarea")).toBeNull()
    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:annotation-b"]
        ?.browserAnnotations?.[0]?.comment
    ).toBe("第二份意见")
  } finally {
    await act(async () =>
      useDesktopSessionStore.setState({ composerDraftsByScope: previousDrafts })
    )
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

it("uses a one-message Computer opt-in and queues it instead of steering the active run", async () => {
  vi.stubGlobal("desktop", { computer: { supported: true } })
  try {
    await act(async () => root.render(
      <Composer
        id="computer-composer"
        draft={composerDocument([{ type: "text", text: "打开计算器" }])}
        sending={false}
        followUpRunId="active"
        models={models}
        selectedModel="test-model"
        selectedProvider="local"
        modelLabel="测试模型"
        permissionMode="full_access"
        effort={null}
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
        onSelectModel={onSelectModel}
        onSelectPermissionMode={vi.fn()}
        onSelectEffort={onSelectEffort}
        computerEnabled
      />
    ))
    const button = container.querySelector<HTMLButtonElement>('[aria-label="电脑操作"]')!
    const form = container.querySelector("form")!
    const send = () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) }
    expect(button.getAttribute("aria-pressed")).toBe("false")
    await act(async () => button.click())
    expect(button.getAttribute("aria-pressed")).toBe("true")
    await act(async () => send())
    expect(onSubmit).toHaveBeenNthCalledWith(1, "queue", true)
    expect(button.getAttribute("aria-pressed")).toBe("false")
    await act(async () => send())
    expect(onSubmit).toHaveBeenNthCalledWith(2, "steer")
  } finally {
    vi.unstubAllGlobals()
  }
})

it("keeps the bundled Computer opt-in scoped to the current draft", async () => {
  vi.stubGlobal("desktop", { computer: { supported: true } })
  await renderComputerComposer("session:first")
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="电脑操作"]')!
  await act(async () => trigger.click())
  expect(trigger.getAttribute("aria-pressed")).toBe("true")
  await setAppHint("记事本")
  await renderComputerComposer("session:second")
  expect(container.querySelector('[aria-label="电脑操作"]')?.getAttribute("aria-pressed")).toBe("false")
  expect(onSubmit).not.toHaveBeenCalled()
  await act(async () => trigger.click())
  expect(container.querySelector<HTMLInputElement>('[aria-label="目标应用（可选）"]')?.value).toBe("")
})

it("passes the app hint only in the armed message", async () => {
  vi.stubGlobal("desktop", { computer: { supported: true } })
  await renderComputerComposer("session:test")
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="电脑操作"]')!.click())
  await setAppHint(" 记事本 ")
  const send = () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await act(async () => { send() })
  expect(onSubmit).toHaveBeenNthCalledWith(1, "queue", true, "记事本")
  await act(async () => { send() })
  expect(onSubmit).toHaveBeenNthCalledWith(2, undefined, "auto")
})

async function setAppHint(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="目标应用（可选）"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

it.each([false, true])("adds a chosen window to the attachment draft only if the chat stays current (switched=%s)", async (switched) => {
  const picture = Promise.withResolvers<{ bytes: Uint8Array }>()
  const shareWindow = vi.fn(() => picture.promise)
  const pasteFiles = vi.fn()
  vi.stubGlobal("desktop", { computer: { supported: true, shareWindow } })
  await renderComputerComposer("session:first", pasteFiles)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="添加上下文"]')!.click())
  const share = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(option => option.textContent?.includes("分享窗口截图"))
  await act(async () => share!.click())
  expect(shareWindow).toHaveBeenCalledOnce()
  expect(pasteFiles).not.toHaveBeenCalled()
  if (switched) await renderComputerComposer("session:second", pasteFiles)
  await act(async () => { picture.resolve({ bytes: new Uint8Array([137, 80, 78, 71]) }) })
  if (switched) expect(pasteFiles).not.toHaveBeenCalled()
  else expect(pasteFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "窗口截图.png", type: "image/png" })])
  expect(onSubmit).not.toHaveBeenCalled()
  expect(container.querySelector('[aria-label="电脑操作"]')?.getAttribute("aria-pressed")).toBe("false")
})

it("keeps ordinary messaging available when Computer Use is unavailable", async () => {
  vi.stubGlobal("desktop", { computer: { supported: false } })
  await renderComputerComposer("session:test")
  expect(container.querySelector('[aria-label="电脑操作"]')).toBeNull()
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(undefined)
})

async function renderComputerComposer(scope: string, onPasteFiles?: (files: readonly File[]) => void) {
  await act(async () => root.render(<Composer
    id="computer-composer" composerScope={scope} draft={composerDocument([{ type: "text", text: "打开计算器" }])}
    sending={false} models={models} selectedModel="test-model" selectedProvider="local" modelLabel="测试模型"
    permissionMode="ask" effort={null} onDraftChange={vi.fn()} onSubmit={onSubmit} onSelectModel={onSelectModel}
    onSelectPermissionMode={vi.fn()} onSelectEffort={onSelectEffort} computerEnabled
    attachmentInteractionEnabled={Boolean(onPasteFiles)} onPasteFiles={onPasteFiles}
  />))
}

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  vi.unstubAllGlobals()
})

async function openCommand(id: string, title: string): Promise<void> {
  const command: ComposerPickerItem = {
    id,
    kind: "command",
    label: title,
    description: "打开选择器",
    command: {
      id,
      title,
      description: "打开选择器",
      selection: "execute",
      requiresEmptyComposer: true,
    },
  }
  await act(async () => {
    root.render(
      <Composer
        id="native-command-test"
        draft={composerDocument([{ type: "text", text: `/${id}` }])}
        sending={false}
        models={models}
        selectedModel="test-model"
        selectedProvider="local"
        modelLabel="测试模型"
        permissionMode="ask"
        effort={null}
        commands={[command]}
        onDraftChange={() => {}}
        onSubmit={onSubmit}
        onCommand={onCommand}
        onSelectModel={onSelectModel}
        onSelectPermissionMode={() => {}}
        onSelectEffort={onSelectEffort}
      />
    )
  })
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')
  expect(option).not.toBeNull()
  await act(async () => {
    option!.click()
  })
}

it("opens the native model picker instead of sending the slash command as a prompt", async () => {
  await openCommand("model", "切换模型")
  const other = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent?.includes("另一个模型")
  )
  expect(other).toBeTruthy()
  await act(async () => {
    other!.click()
  })
  expect(onSelectModel).toHaveBeenCalledWith(models[1])
  expect(onCommand).not.toHaveBeenCalled()
  expect(onSubmit).not.toHaveBeenCalled()
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe("")
})

it("opens supported reasoning tiers and applies the selected effort without a prompt", async () => {
  await openCommand("effort", "推理强度")
  const high = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent?.includes("高")
  )
  expect(high).toBeTruthy()
  await act(async () => {
    high!.click()
  })
  expect(onSelectEffort).toHaveBeenCalledWith("high")
  expect(onCommand).not.toHaveBeenCalled()
  expect(onSubmit).not.toHaveBeenCalled()
})

it("selects one eligible target from + and queues the preserved draft even in full access mode", async () => {
  const source = emptySessionView("source").session
  const target = { ...emptySessionView("target").session, title: "构建", cwd: "D:/target" }
  const recent = { ...target, id: "recent", cwd: "D:/recent", updatedAt: 20, status: "running" as const }
  const older = { ...recent, id: "older", cwd: "D:/older", updatedAt: 30 }
  const activity: DesktopSessionActivity = {
    session: target, executionState: "needs_input", attentionState: "read", activitySeq: 1, updatedAt: 1,
  }
  const attachment = {
    draftId: "log", taskId: "log", displayName: "build.log", declaredMediaType: "text/plain",
    sizeBytes: 4, status: "ready" as const, bytesUploaded: 4, progress: 1, assetId: "file",
  }
  const submit = vi.fn()
  function Fixture() {
    const [draft, setDraft] = useState(composerDocument([{ type: "text", text: "看看结果" }]))
    const [attachments, setAttachments] = useState([attachment])
    return <Composer
      id="observation-test"
      activeSessionId={source.id}
      observationEnabled
      conversations={[
        source, target, recent, older, { ...target, id: "child", title: "子会话", parentId: source.id },
        { ...target, id: "memory", title: "临时会话", storage: "memory" },
        { ...target, id: "closing", title: "正在关闭", status: "closing" },
        { ...target, id: "archived", title: "已归档", status: "archived" },
        { ...target, id: "channel", title: "渠道会话", metadata: { source: "channel" } },
      ]}
      conversationActivities={{
        target: activity,
        recent: { ...activity, session: recent, executionState: "running", updatedAt: 40 },
      }}
      draft={draft}
      followUpRunId="active"
      running
      sending={false}
      models={models}
      selectedModel="test-model"
      selectedProvider="local"
      modelLabel="测试模型"
      permissionMode="full_access"
      effort={null}
      attachments={attachments}
      onRemoveAttachment={() => setAttachments([])}
      onDraftChange={setDraft}
      onSubmit={(delivery) => submit(delivery, draft)}
      onSelectModel={onSelectModel}
      onSelectPermissionMode={() => {}}
      onSelectEffort={onSelectEffort}
    />
  }
  await act(async () => root.render(<Fixture />))
  await act(async () => container.querySelector<HTMLButtonElement>("[data-context-picker-toggle]")?.click())
  const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  await act(async () => options().at(-1)?.click())
  expect(options()).toHaveLength(4)
  expect(options()[0]?.textContent).toContain("D:/target")
  expect(options()[0]?.textContent).toContain("等你处理")
  expect(options()[1]?.textContent).toContain("D:/recent")
  expect(options()[1]?.textContent).toContain("执行中")
  expect(options()[2]?.textContent).toContain("D:/older")
  await act(async () => options()[0]?.click())
  expect(submit).not.toHaveBeenCalled()
  expect(container.textContent).toContain("build.log")
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除附件 build.log"]')?.click())
  expect(container.textContent).toContain("观察会话需要排队发送")
  await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(submit).toHaveBeenCalledExactlyOnceWith("queue", {
    version: 1, items: [{ type: "text", text: "observe-session target\n看看结果" }],
  })
})
