// @vitest-environment jsdom
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { NewConversationStart } from "../new-conversation-start"

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("@renderer/components/desktop/shared/aora-bot/aora-avatar", () => ({
  AoraAvatar: () => null,
}))

type Props = ComponentProps<typeof NewConversationStart> & {
  onRetryLoad: () => void
  onOpenSettings: (section: "providers" | "diagnostics") => void
}
const model = { id: "model", label: "测试模型", provider: "本地", providerName: "local" }
const project = {
  id: "project",
  name: "项目",
  path: "D:/project",
  available: true,
  lastOpenedAt: 1,
}
let root: Root
let container: HTMLDivElement
let props: Props

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  props = {
    draft: composerDocument([{ type: "text", text: "保留这份草稿" }]),
    sending: false,
    loadStatus: "ready",
    daemonStatus: { phase: "ready", message: "后台已就绪", updatedAt: 1 },
    projects: [project],
    selectedProject: project,
    workspaceMode: "project",
    selectedProjectGit: true,
    branch: null,
    branches: [],
    models: [model],
    selectedModel: model.id,
    selectedProvider: model.providerName,
    selectedPermissionMode: "ask",
    effort: null,
    operationError: null,
    skills: [],
    attachments: [],
    attachmentInteractionEnabled: false,
    panelOpen: false,
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    onPickFiles: vi.fn(),
    onDropFiles: vi.fn(),
    onPasteFiles: vi.fn(),
    onPasteTextAttachment: vi.fn(),
    onCancelAttachment: vi.fn(),
    onRetryAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onChooseProject: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectOutsideProject: vi.fn(),
    onCheckoutBranch: vi.fn(async () => {}),
    onCreateAndCheckoutBranch: vi.fn(async () => {}),
    onSelectModel: vi.fn(),
    onSelectPermissionMode: vi.fn(),
    onSelectEffort: vi.fn(),
    onTogglePanel: vi.fn(),
    onRetryLoad: vi.fn(),
    onOpenSettings: vi.fn(),
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(patch: Partial<Props> = {}) {
  props = { ...props, ...patch }
  await act(async () => root.render(<NewConversationStart {...props} />))
}
const setup = () => container.querySelector<HTMLElement>('[aria-label="开始前准备"]')
const send = () => container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!
function action(text: string) {
  const button = [...(setup()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (item) => item.textContent === text
  )
  expect(button, `缺少下一步入口：${text}`).toBeDefined()
  return button!
}

it.each(["idle", "loading"] as const)(
  "waits for %s initialization without suggesting model setup",
  async (loadStatus) => {
    await render({ loadStatus, models: [], selectedModel: null })
    expect(setup()?.getAttribute("role")).toBe("status")
    expect(setup()?.textContent).toContain("正在加载")
    expect(setup()?.textContent).not.toContain("配置模型")
    expect(send().disabled).toBe(true)
  }
)

it("retries failed initialization without clearing the draft or starting a task", async () => {
  await render({ loadStatus: "error" })
  expect(send().disabled).toBe(true)
  await act(async () => action("重新加载").click())
  expect(props.onRetryLoad).toHaveBeenCalledTimes(1)
  expect(props.onSubmit).not.toHaveBeenCalled()
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe("保留这份草稿")
})

it("opens existing diagnostics when the daemon connection fails", async () => {
  await render({ daemonStatus: { phase: "error", message: "连接中断", updatedAt: 2 } })
  await act(async () => action("检查连接").click())
  expect(props.onOpenSettings).toHaveBeenCalledWith("diagnostics")
  expect(send().disabled).toBe(true)
  expect(props.onSubmit).not.toHaveBeenCalled()
})

it("offers model configuration before project selection and blocks Enter as well as clicks", async () => {
  await render({ models: [], selectedModel: null, selectedProject: null })
  await act(async () => action("配置模型").click())
  expect(props.onOpenSettings).toHaveBeenCalledWith("providers")
  expect(send().disabled).toBe(true)
  await act(async () => {
    send().click()
    container
      .querySelector<HTMLElement>('[role="textbox"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      )
  })
  expect(props.onSubmit).not.toHaveBeenCalled()
  expect(props.onSelectOutsideProject).not.toHaveBeenCalled()
})

it.each([null, "missing"])(
  "reuses the model picker for an unavailable selection (%s)",
  async (selectedModel) => {
    await render({ selectedModel })
    expect(send().disabled).toBe(true)
    await act(async () => action("选择模型").click())
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes(model.label)
    )!
    expect(option).toBeDefined()
    await act(async () => option.click())
    expect(props.onSelectModel).toHaveBeenCalledWith(model)
    expect(props.onSubmit).not.toHaveBeenCalled()
    await render({ selectedModel: model.id })
    expect(setup()).toBeNull()
    expect(send().disabled).toBe(false)
  }
)

it("checks the provider as well as the selected model id", async () => {
  await render({ selectedProvider: "removed-provider" })
  expect(send().disabled).toBe(true)
  expect(action("选择模型")).toBeDefined()
})

it("opens the existing location picker and accepts working outside a project", async () => {
  await render({ selectedProject: null })
  expect(send().disabled).toBe(true)
  await act(async () => action("选择项目").click())
  const outside = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent?.includes("不在项目中工作")
  )!
  expect(outside).toBeDefined()
  await act(async () => outside.click())
  expect(props.onSelectOutsideProject).toHaveBeenCalledTimes(1)
  await render({ workspaceMode: "outside_project" })
  expect(setup()).toBeNull()
  expect(send().disabled).toBe(false)
})

it("offers a new directory when the selected project is unavailable", async () => {
  await render({ selectedProject: { ...project, available: false } })
  expect(send().disabled).toBe(true)
  await act(async () => action("重新选择项目").click())
  expect(props.onChooseProject).toHaveBeenCalledTimes(1)
  expect(props.onSubmit).not.toHaveBeenCalled()
})

it("keeps ready starts quiet and does not require a branch in an empty repository", async () => {
  await render()
  expect(setup()).toBeNull()
  expect(send().disabled).toBe(false)
  await act(async () => send().click())
  expect(props.onSubmit).toHaveBeenCalledTimes(1)
})
