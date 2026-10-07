// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: { getState: () => ({ refreshBootstrap: async () => {} }) },
}))
import { DefaultPermissionControl, RuntimeDefaultControl } from "./general-quick-controls"
let container: HTMLDivElement, root: Root
const permission = { mode: "default" as const, deniedTools: ["Shell"] }
const update = vi.fn(async (input: { permission: typeof permission }) => ({
  permission: input.permission,
}))
const runtime = {
  userConfig: { kind: "native" as const, env: { NODE_ENV: "development" }, secretEnv: ["TOKEN"] },
  wslSupported: true,
  restartRequired: false,
  source: "用户默认",
}
const save = vi.fn(async () => ({ ...runtime, restartRequired: true }))
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  update.mockClear()
  save.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      permissionSettings: { snapshot: async () => ({ permission }), update },
      runtimeSettings: { snapshot: async () => runtime, save },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function selectOption(label: string, option: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === option)!
      .click()
  )
}
it("requires confirmation for auto approval and preserves existing restrictions", async () => {
  await act(async () => root.render(<DefaultPermissionControl />))
  await selectOption("默认批准方式", "自动批准")
  expect(update).not.toHaveBeenCalled()
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "启用自动批准")!
      .click()
  )
  expect(update).toHaveBeenCalledWith({
    permission: { ...permission, mode: "full_auto" },
    expectedPermission: permission,
  })
})
it("keeps shell and variable settings when changing only the default environment", async () => {
  await act(async () => root.render(<RuntimeDefaultControl />))
  await selectOption("智能体默认环境", "WSL")
  expect(save).toHaveBeenCalledWith({
    config: { ...runtime.userConfig, kind: "wsl" },
    expected: runtime.userConfig,
  })
})
