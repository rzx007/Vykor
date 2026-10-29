// @vitest-environment jsdom

import { act, useState, type ComponentProps } from "react"
import { createPortal } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopModel } from "@shared/session-types"
import { NewConversationStart } from "../../session/new-conversation-start"
import { handlePickerMenuKeyDown, PermissionModeMenu, PickerMenuItem } from "../controls"
import { EffortPicker } from "../effort-picker"
import { ModelPicker } from "../model-picker"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
// The startup toolbar is separate from the rich text editor and avatar renderer.
vi.mock("../composer", () => ({ Composer: () => null }))
vi.mock("@renderer/components/desktop/shared/aora-bot/aora-avatar", () => ({
  AoraAvatar: () => null,
}))

const models: DesktopModel[] = Array.from({ length: 8 }, (_, index) => ({
  id: `model-${index + 1}`,
  label: `Model ${index + 1}`,
  provider: "Provider",
  providerName: "provider",
}))

function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const matches = [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label
  )
  const result =
    matches.find((item) => item.getAttribute("role")?.startsWith("menuitem")) ?? matches[0]
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

async function press(
  target: Element,
  key: string,
  options: KeyboardEventInit = {}
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click())
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("composer picker keyboard navigation", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
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

  async function renderModelPicker(onSelectModel = vi.fn()): Promise<HTMLButtonElement> {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <ModelPicker
          open={open}
          onOpenChange={setOpen}
          models={models}
          selectedModel="model-1"
          selectedProvider="provider"
          modelLabel="Model 1"
          onSelectModel={onSelectModel}
        />
      )
    }
    await act(async () => root.render(<Harness />))
    return button("Model 1", container)
  }

  it("moves through effort options with arrows and endpoints without selecting", async () => {
    const onSelect = vi.fn()
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <EffortPicker
          open={open}
          onOpenChange={setOpen}
          tiers={["low", "high"]}
          value="low"
          onSelect={onSelect}
        />
      )
    }
    await act(async () => root.render(<Harness />))
    const trigger = button("推理强度", container)
    await click(trigger)
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    options[0]!.focus()
    await press(options[0]!, "ArrowDown")
    expect(document.activeElement).toBe(options[1])
    await press(options[1]!, "End")
    expect(document.activeElement).toBe(options[2])
    await press(options[2]!, "ArrowDown")
    expect(document.activeElement).toBe(options[0])
    await press(options[0]!, "ArrowUp")
    expect(document.activeElement).toBe(options[2])
    await press(options[2]!, "Home")
    expect(document.activeElement).toBe(options[0])
    expect(onSelect).not.toHaveBeenCalled()
    expect(trigger.title).toContain("低")
  })

  it("shows and selects an unknown effort tier", async () => {
    const onSelect = vi.fn()
    await act(async () =>
      root.render(
        <EffortPicker
          open
          onOpenChange={() => undefined}
          tiers={["constructor"]}
          value="constructor"
          onSelect={onSelect}
        />
      )
    )
    const option = document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[1]!
    expect(button("推理强度", container).title).toContain("constructor")
    await click(option)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("constructor")
  })

  it("keeps model search editing and composition while arrows reach filtered options", async () => {
    const onSelect = vi.fn()
    const trigger = await renderModelPicker(onSelect)
    await click(trigger)
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="搜索模型"]')!
    input.focus()
    await type(input, "Model 8")
    expect((await press(input, "Home")).defaultPrevented).toBe(false)
    expect((await press(input, "End")).defaultPrevented).toBe(false)
    await press(input, "ArrowDown", { isComposing: true })
    expect(document.activeElement).toBe(input)
    await press(input, "ArrowDown", { keyCode: 229 })
    expect(document.activeElement).toBe(input)
    await press(input, "ArrowDown")
    expect(document.activeElement).toBe(button("Model 8"))
    expect(onSelect).not.toHaveBeenCalled()
    // Native buttons own Enter/Space activation; navigation must not click them again.
    const enter = await press(document.activeElement!, "Enter")
    expect(enter.defaultPrevented).toBe(false)
    await click(button("Model 8"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(models[7])
  })

  it("skips unavailable and hidden choices without entering a nested menu", async () => {
    await act(async () =>
      root.render(
        <div role="menu" onKeyDown={handlePickerMenuKeyDown}>
          <PickerMenuItem onClick={() => undefined}>First</PickerMenuItem>
          <PickerMenuItem disabled onClick={() => undefined}>
            Disabled
          </PickerMenuItem>
          <div hidden>
            <PickerMenuItem onClick={() => undefined}>Hidden</PickerMenuItem>
          </div>
          <button role="menuitem" aria-disabled="true">
            Unavailable
          </button>
          <div role="menu">
            <PickerMenuItem onClick={() => undefined}>Nested</PickerMenuItem>
          </div>
          <PickerMenuItem onClick={() => undefined}>Last</PickerMenuItem>
        </div>
      )
    )
    const first = button("First", container)
    first.focus()
    await press(first, "ArrowDown")
    expect(document.activeElement).toBe(button("Last", container))
    await press(document.activeElement!, "ArrowUp")
    expect(document.activeElement).toBe(first)
    const nested = button("Nested", container)
    nested.focus()
    expect((await press(nested, "Home")).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(nested)
  })

  it("leaves modified shortcuts and portal key events outside its menu alone", async () => {
    await act(async () =>
      root.render(
        <div role="menu" onKeyDown={handlePickerMenuKeyDown}>
          <PickerMenuItem onClick={() => undefined}>First</PickerMenuItem>
          <PickerMenuItem onClick={() => undefined}>Last</PickerMenuItem>
          {createPortal(<button>Portal control</button>, document.body)}
        </div>
      )
    )
    const first = button("First", container)
    first.focus()
    expect((await press(first, "End", { ctrlKey: true })).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(first)
    first.addEventListener("keydown", (event) => event.preventDefault(), { once: true })
    await press(first, "End")
    expect(document.activeElement).toBe(first)
    const portalControl = button("Portal control")
    portalControl.focus()
    expect((await press(portalControl, "ArrowDown")).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(portalControl)
  })

  it("reaches provider expansion and navigates its dialog, then restores the model trigger", async () => {
    const trigger = await renderModelPicker()
    await click(trigger)
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="搜索模型"]')!
    input.focus()
    await press(input, "ArrowDown")
    for (let index = 0; index < 6; index++) await press(document.activeElement!, "ArrowDown")
    expect(document.activeElement).toBe(button("展开全部 8 个模型"))
    await click(document.activeElement as HTMLElement)
    const dialogInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="搜索 Provider 模型"]'
    )!
    dialogInput.focus()
    await type(dialogInput, "Model 7")
    await press(dialogInput, "ArrowUp")
    expect(document.activeElement).toBe(button("Model 7"))
    await press(document.activeElement!, "Escape")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(trigger)
  })

  it("leaves Escape closing and focus restoration to the model popover", async () => {
    const trigger = await renderModelPicker()
    await click(trigger)
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="搜索模型"]')!
    input.focus()
    await press(input, "ArrowDown")
    expect(document.activeElement).toBe(button("Model 1"))
    await press(document.activeElement!, "Escape")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(trigger)
  })

  it("navigates permission modes while keeping full access behind confirmation", async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(<PermissionModeMenu selected="ask" onSelect={onSelect} />))
    const options = [...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    options[0]!.focus()
    await press(options[0]!, "End")
    expect(document.activeElement).toBe(options[2])
    await click(options[2]!)
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    await click(button("取消"))
    expect(onSelect).not.toHaveBeenCalled()
    await click(options[2]!)
    await click(button("确认"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("full_access")
  })

  it("skips disabled runtime options and restores the startup trigger after Escape", async () => {
    await renderStart()
    const trigger = button("本地", container)
    await click(trigger)
    const local = document.body.querySelector<HTMLElement>('[role="menuitemradio"]')!
    const menu = local.closest<HTMLElement>('[role="menu"]')!
    menu.focus()
    await press(menu, "ArrowUp")
    expect(document.activeElement).toBe(local)
    await press(local, "ArrowDown")
    expect(document.activeElement).toBe(local)
    await press(local, "Escape")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(trigger)
  })

  it("reaches filtered projects and branch creation from startup searches", async () => {
    const onSelectProject = vi.fn()
    const onCreateAndCheckoutBranch = vi.fn().mockResolvedValue(undefined)
    await renderStart({ onSelectProject, onCreateAndCheckoutBranch })
    await click(button("Alpha", container))
    const projectInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="搜索项目"]'
    )!
    projectInput.focus()
    await type(projectInput, "Beta")
    await press(projectInput, "ArrowDown")
    expect(document.activeElement).toBe(button("Beta"))
    await click(document.activeElement as HTMLElement)
    expect(onSelectProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Beta" }))

    await click(button("main", container))
    const branchInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="搜索 Alpha 分支"]'
    )!
    branchInput.focus()
    await type(branchInput, "feature/new")
    await press(branchInput, "ArrowDown")
    expect(document.activeElement).toBe(button("创建并检出 feature/new"))
    await click(document.activeElement as HTMLElement)
    expect(onCreateAndCheckoutBranch).toHaveBeenCalledTimes(1)
    expect(onCreateAndCheckoutBranch).toHaveBeenCalledWith("feature/new")
  })

  async function renderStart(
    overrides: Partial<ComponentProps<typeof NewConversationStart>> = {}
  ): Promise<void> {
    const projects = ["Alpha", "Beta"].map((name) => ({
      id: name,
      name,
      path: `D:/${name}`,
      available: true,
      lastOpenedAt: 0,
    }))
    const noop = (): void => undefined
    await act(async () =>
      root.render(
        <NewConversationStart
          draft={{ version: 1, items: [] }}
          sending={false}
          loadStatus="ready"
          daemonStatus={{ phase: "ready", message: "", updatedAt: 0 }}
          projects={projects}
          selectedProject={projects[0]!}
          workspaceMode="project"
          selectedProjectGit
          branch="main"
          branches={["main", "develop"]}
          models={[]}
          selectedModel={null}
          selectedProvider={null}
          selectedPermissionMode="ask"
          effort={null}
          operationError={null}
          skills={[]}
          attachments={[]}
          attachmentInteractionEnabled
          panelOpen
          onDraftChange={noop}
          onSubmit={noop}
          onPickFiles={noop}
          onDropFiles={noop}
          onPasteFiles={noop}
          onPasteTextAttachment={noop}
          onCancelAttachment={noop}
          onRetryAttachment={noop}
          onRemoveAttachment={noop}
          onChooseProject={noop}
          onSelectProject={noop}
          onSelectOutsideProject={noop}
          onCheckoutBranch={async () => undefined}
          onCreateAndCheckoutBranch={async () => undefined}
          onSelectModel={noop}
          onSelectPermissionMode={noop}
          onSelectEffort={noop}
          onTogglePanel={noop}
          onRetryLoad={noop}
          onOpenSettings={noop}
          {...overrides}
        />
      )
    )
  }
})
