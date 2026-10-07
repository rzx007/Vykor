// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RuntimeSettingsSnapshot } from "@shared/runtime-settings-types"
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector: (state: { projects: [] }) => unknown) =>
    selector({ projects: [] }),
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
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    save.mockClear()
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { runtimeSettings: { snapshot: async () => snapshot, save } },
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
  it("uses placeholders for input examples while retaining labels and secret guidance", () => {
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
          env: { NODE_ENV: "development" },
          secretEnv: ["API_TOKEN"],
        }),
        secrets: {},
      })
    )
  })
})
