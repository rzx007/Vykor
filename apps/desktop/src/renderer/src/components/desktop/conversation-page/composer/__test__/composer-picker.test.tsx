// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ComposerPicker, type ComposerPickerItem } from "../composer-picker"
import { pickerItems, toComposerSkills } from "../composer-picker-model"
import { ContextPicker, type ContextPickerItem } from "../context-picker"

const skills: ComposerPickerItem[] = [
  {
    id: "skill:writing-plans",
    kind: "skill",
    label: "Writing Plans",
    description: "Write an implementation plan",
    sourceLabel: "个人",
    skill: {
      name: "writing-plans",
      path: "D:/skills/writing-plans/SKILL.md",
      displayName: "Writing Plans",
      source: "user",
    },
  },
  {
    id: "skill:review",
    kind: "skill",
    label: "Review",
    description: "Review the current diff",
    sourceLabel: "项目",
    skill: {
      name: "review",
      path: "D:/repo/.agents/skills/review/SKILL.md",
      displayName: "Review",
      source: "project",
    },
  },
]

it("uses the catalog skill identity while keeping the slash alias searchable", () => {
  const [skill] = toComposerSkills([
    { kind: "template", name: "/dt", skillName: "do-thing", path: "D:/do-thing/SKILL.md" },
  ])
  expect(skill?.name).toBe("do-thing")
  const items = pickerItems({
    trigger: { sigil: "/", mode: "inline", query: "dt" },
    commands: [],
    skills: [{ id: "skill", kind: "skill", label: "Do thing", description: "", skill }],
  })
  expect(items).toHaveLength(1)
  expect(items[0]?.skill?.name).toBe("do-thing")
})

describe("ComposerPicker", () => {
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

  it("does not select a command while Enter is confirming Chinese composition", async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(
        createElement(ComposerPicker, { items: skills, query: "", onSelect, onDismiss: vi.fn() })
      )
    })
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })
      )
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("resets keyboard selection when available items change without changing their count", async () => {
    const onSelect = vi.fn()
    const props = { query: "", onSelect, onDismiss: vi.fn() }
    await act(async () => {
      root.render(createElement(ComposerPicker, { ...props, items: skills }))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    await act(async () => {
      root.render(createElement(ComposerPicker, { ...props, items: [...skills].reverse() }))
    })
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("Review")
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith(skills[1])
  })

  it("shows only matching Skills and selects the highlighted item with Enter", async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(
        createElement(ComposerPicker, {
          items: skills,
          query: "writ",
          onSelect,
          onDismiss: vi.fn(),
        })
      )
    })

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(container.textContent).toContain("Writing Plans")

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith(skills[0])
  })

  it("moves the selection, dismisses with Escape, and keeps mouse selection available", async () => {
    const onSelect = vi.fn()
    const onDismiss = vi.fn()
    await act(async () => {
      root.render(createElement(ComposerPicker, { items: skills, query: "", onSelect, onDismiss }))
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith(skills[1])

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledOnce()

    const firstOption = container.querySelector<HTMLButtonElement>('[role="option"]')
    await act(async () => firstOption?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(onSelect).toHaveBeenCalledWith(skills[0])
  })

  it("renders category headings and dismisses when clicking outside", async () => {
    const onDismiss = vi.fn()
    const items: ContextPickerItem[] = [
      {
        id: "files",
        label: "文件和文件夹",
        description: "添加本地文件",
        group: "添加",
        action: { kind: "files" },
      },
      {
        id: "chat",
        label: "历史会话",
        description: "引用历史对话",
        group: "历史对话",
        action: { kind: "conversation", sessionId: "s2", displayName: "历史会话" },
      },
    ]
    await act(async () => {
      root.render(
        createElement(ContextPicker, {
          items,
          query: "",
          onSelect: vi.fn(),
          onDismiss,
        })
      )
    })

    expect(container.querySelector('[aria-label="添加上下文"]')).not.toBeNull()
    expect(container.textContent).toContain("添加")
    expect(container.textContent).toContain("历史对话")

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("keeps the title filter when switching the same list to observation", async () => {
    const onSelect = vi.fn()
    const items: ContextPickerItem[] = [
      {
        id: "build",
        label: "构建桌面版",
        description: "引用历史对话",
        group: "历史对话",
        observation: { priority: 1, workspace: "D:/build", status: "执行中", updatedAt: 1 },
        action: { kind: "conversation", sessionId: "build", displayName: "构建桌面版" },
      },
      {
        id: "notes",
        label: "记录版本",
        description: "引用历史对话",
        group: "历史对话",
        observation: { priority: 0, workspace: "D:/notes", status: "等你处理", updatedAt: 1 },
        action: { kind: "conversation", sessionId: "notes", displayName: "记录版本" },
      },
      {
        id: "observe-mode",
        label: "观察进度",
        description: "选择要观察的会话",
        group: "添加",
        action: { kind: "observe-mode" },
      },
    ]
    const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    await act(async () =>
      root.render(createElement(ContextPicker, { items, query: "构建", onSelect, onDismiss: vi.fn() }))
    )
    expect(options()).toHaveLength(2)
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true")
    expect(options()[1]?.textContent).toContain("观察进度")

    await act(async () => options()[1]?.click())
    expect(onSelect).not.toHaveBeenCalled()
    expect(options()).toHaveLength(2)
    expect(options()[0]?.textContent).toContain("构建桌面版")
    expect(options()[0]?.textContent).toContain("D:/build")
    expect(options()[0]?.textContent).toContain("执行中")
    expect(options()[1]?.textContent).toContain("引用历史")

    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    )
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      ...items[0],
      action: { kind: "observe-session", sessionId: "build" },
    })
  })

  it("keeps the highlighted observation target when live activity reorders the list", async () => {
    const onSelect = vi.fn()
    const first: ContextPickerItem = {
      id: "first",
      label: "构建桌面版",
      description: "引用历史对话",
      group: "历史对话",
      observation: { priority: 0, workspace: "D:/build", status: "等你处理", updatedAt: 1 },
      action: { kind: "conversation", sessionId: "first", displayName: "构建桌面版" },
    }
    const second: ContextPickerItem = {
      ...first,
      id: "second",
      label: "发布桌面版",
      observation: { priority: 1, workspace: "D:/release", status: "执行中", updatedAt: 1 },
      action: { kind: "conversation", sessionId: "second", displayName: "发布桌面版" },
    }
    const mode: ContextPickerItem = {
      id: "observe-mode", label: "观察进度", description: "选择会话", group: "添加",
      action: { kind: "observe-mode" },
    }
    const props = { query: "", onSelect, onDismiss: vi.fn() }
    await act(async () => root.render(createElement(ContextPicker, { ...props, items: [first, second, mode] })))
    const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    await act(async () => options().at(-1)?.click())
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true")
    const updated = { ...first, observation: { priority: 2, workspace: "D:/build", status: "已完成", updatedAt: 2 } }
    await act(async () => root.render(createElement(ContextPicker, { ...props, items: [updated, second, mode] })))
    expect(options()[0]?.textContent).toContain("发布桌面版")
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true")
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      ...updated,
      action: { kind: "observe-session", sessionId: "first" },
    })
  })
})

describe("pickerItems", () => {
  const commands: ComposerPickerItem[] = [
    {
      id: "compact",
      kind: "command",
      label: "Compact",
      description: "Summarize conversation to reduce context size",
      command: {
        id: "compact",
        title: "Compact",
        description: "Summarize conversation to reduce context size",
        requiresEmptyComposer: true,
        selection: "execute",
      },
    },
  ]

  it("includes Desktop commands with Skills for a leading slash but keeps inline slash Skill-only", () => {
    expect(
      pickerItems({
        trigger: { sigil: "/", query: "", from: 0, to: 1, mode: "leading" },
        commands,
        skills,
      }).map((item) => item.id)
    ).toEqual(["compact", "skill:writing-plans", "skill:review"])

    expect(
      pickerItems({
        trigger: { sigil: "/", query: "", from: 3, to: 4, mode: "inline" },
        commands,
        skills,
      }).map((item) => item.id)
    ).toEqual(["skill:writing-plans", "skill:review"])
  })
})
