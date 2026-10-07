// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionRulesEditor } from "./permission-settings-rules"

describe("PermissionRulesEditor", () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const change = async (input: HTMLTextAreaElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        value
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  it("edits real rule drafts and cancels back to the saved values", async () => {
    const save = vi.fn()
    await act(async () =>
      root.render(
        <PermissionRulesEditor
          permission={{ mode: "default", deniedTools: ["Write"] }}
          busy={false}
          onSave={save}
        />
      )
    )
    const input = container.querySelector<HTMLTextAreaElement>("#permissions-deniedTools")!
    await change(input, "Read\nShell\n")
    expect(input.value).toBe("Read\nShell\n")
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "保存权限设置")!
        .click()
    )
    expect(save).toHaveBeenCalledWith(
      { mode: "default", deniedTools: ["Read", "Shell"] },
      { mode: "default", deniedTools: ["Write"] }
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "取消修改")!
        .click()
    )
    expect(input.value).toBe("Write")
  })
  it("keeps labels and safety guidance visible when format help becomes a placeholder", async () => {
    await act(async () =>
      root.render(
        <PermissionRulesEditor
          permission={{ mode: "default", deniedTools: ["Write"] }}
          busy={false}
          onSave={vi.fn()}
        />
      )
    )
    const input = container.querySelector<HTMLTextAreaElement>("#permissions-deniedTools")!
    expect(input.placeholder).toBe("每行一项，留空不设置")
    expect(container.querySelector('label[for="permissions-deniedTools"]')?.textContent).toBe(
      "禁止使用的工具"
    )
    expect(container.textContent).toContain("禁止规则优先于自动批准。")
    expect(container.textContent).not.toContain("每行一项，留空表示不设置。")
    await change(input, "Shell")
    expect(container.querySelector('label[for="permissions-deniedTools"]')?.textContent).toBe(
      "禁止使用的工具"
    )
  })
  it("keeps the original edit baseline when another section refreshes the snapshot", async () => {
    const save = vi.fn()
    const original = { mode: "default" as const, deniedTools: ["Write"] }
    await act(async () =>
      root.render(<PermissionRulesEditor permission={original} busy={false} onSave={save} />)
    )
    await change(container.querySelector<HTMLTextAreaElement>("#permissions-deniedTools")!, "Shell")
    await act(async () =>
      root.render(
        <PermissionRulesEditor
          permission={{ mode: "plan", deniedTools: ["Read"] }}
          busy={false}
          onSave={save}
        />
      )
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "保存权限设置")!
        .click()
    )
    expect(save).toHaveBeenCalledWith({ mode: "default", deniedTools: ["Shell"] }, original)
  })
})
