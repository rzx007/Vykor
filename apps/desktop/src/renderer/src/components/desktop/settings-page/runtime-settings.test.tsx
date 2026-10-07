// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RuntimeSettingsSnapshot } from "@shared/runtime-settings-types"
const scopeStore = vi.hoisted(() => ({
  projects: [{ id: "project", name: "Project", path: "D:/project" }],
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (
    selector: (state: { projects: Array<{ id: string; name: string; path: string }> }) => unknown
  ) => selector(scopeStore),
}))
import { RuntimeSettings } from "./runtime-settings"

const snapshot: RuntimeSettingsSnapshot = {
  userConfig: { kind: "native", env: { NODE_ENV: "development" }, secretEnv: ["API_TOKEN"] },
  projectConfig: null,
  activeDefault: { kind: "native" },
  effective: { kind: "native" },
  source: "用户默认",
  restartRequired: false,
  wslSupported: false,
  inheritedVariableNames: ["PATH"],
  distributions: [],
  secretRevision: "saved-revision",
}
describe("runtime settings aligned fields", () => {
  let container: HTMLDivElement, root: Root
  const save = vi.fn(async () => snapshot)
  const read = vi.fn(async (_input?: { cwd?: string }) => snapshot)
  beforeEach(async () => {
    scopeStore.projects = [{ id: "project", name: "Project", path: "D:/project" }]
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    save.mockClear()
    read.mockClear()
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { runtimeSettings: { snapshot: read, save } },
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<RuntimeSettings />))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  it("keeps default Shell parameters hidden", () => {
    expect(container.querySelector("#runtime-shell-args")).toBeNull()
  })
  it("reveals custom Shell fields only when requested", async () => {
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-label="使用自定义命令 Shell"]')!.click()
    )
    expect(
      container.querySelector<HTMLTextAreaElement>("#runtime-shell-args")?.placeholder
    ).toContain("每行一个参数")
    expect(container.querySelector('label[for="runtime-shell-args"]')?.textContent).toBe(
      "命令 Shell 参数"
    )
    expect(container.querySelector<HTMLInputElement>("#runtime-env-name-0")?.placeholder).toBe(
      "例如 NODE_ENV"
    )
    const secret = container.querySelector<HTMLInputElement>("#runtime-env-value-1")!
    expect(secret.type).toBe("password")
    expect(secret.placeholder).toBe("留空保留已保存值")
    expect(secret.value).toBe("")
    expect(container.textContent).toContain("机密不回显、不导出")
  })
  it("retains the save payload and secret conflict check after regrouping fields", async () => {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#runtime-env-value-0")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "production"
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "保存环境设置")!
        .click()
    )
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: snapshot.userConfig,
        expectedSecretRevision: snapshot.secretRevision,
        config: expect.objectContaining({
          kind: "native",
          env: { NODE_ENV: "production" },
          secretEnv: ["API_TOKEN"],
        }),
        secrets: {},
      })
    )
  })
  it("does not offer to save an unchanged form, and cancelling restores saved values", async () => {
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "保存环境设置"
      )
    ).toBe(false)
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#runtime-env-value-0")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "changed"
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "取消修改")!
        .click()
    )
    expect(container.querySelector<HTMLInputElement>("#runtime-env-value-0")!.value).toBe(
      "development"
    )
    expect(save).not.toHaveBeenCalled()
  })
  it("protects an unsaved draft before changing the configuration scope", async () => {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#runtime-env-value-0")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "my-draft"
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    async function chooseProject() {
      await act(async () => container.querySelector<HTMLButtonElement>("#runtime-scope")!.click())
      await act(async () =>
        [...document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((item) => item.textContent === "Project")!
          .click()
      )
    }
    await chooseProject()
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent === "继续编辑")!
        .click()
    )
    expect(container.querySelector<HTMLInputElement>("#runtime-env-value-0")!.value).toBe(
      "my-draft"
    )
    await chooseProject()
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent === "放弃修改并切换")!
        .click()
    )
    expect(read).toHaveBeenLastCalledWith({ cwd: "D:/project" })
    expect(save).not.toHaveBeenCalled()
  })
  it("does not silently fall back to editing user defaults when a project disappears", async () => {
    await act(async () => container.querySelector<HTMLButtonElement>("#runtime-scope")!.click())
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent === "Project")!
        .click()
    )
    const reads = read.mock.calls.length
    scopeStore.projects = []
    await act(async () => root.render(<RuntimeSettings />))
    expect(container.querySelector("#runtime-scope")?.textContent).toContain("选项不可用")
    expect(read).toHaveBeenCalledTimes(reads)
    expect(container.textContent).toContain("所选项目已移除")
    expect(save).not.toHaveBeenCalled()
  })
})
