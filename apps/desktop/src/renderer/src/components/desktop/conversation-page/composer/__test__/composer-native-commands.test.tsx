// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { Composer } from "../composer"
import type { ComposerPickerItem } from "../composer-picker"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"

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

beforeEach(() => {
  vi.clearAllMocks()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
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
        permissionMode="default"
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
