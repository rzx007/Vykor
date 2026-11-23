// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  defaultGitPreferences,
  type GitSettingsAPI,
  type GitSettingsSnapshot,
} from "@shared/git-settings-types"
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (select: (state: unknown) => unknown) =>
    select({ projects: [{ id: "sample", name: "示例项目" }] }),
}))
import { GitSettings } from "../git-settings"
let container: HTMLDivElement, root: Root, saved: GitSettingsSnapshot
const readSnapshot = vi.fn<GitSettingsAPI["snapshot"]>()
const updatePreferences = vi.fn(
  async (input: { preferences: typeof defaultGitPreferences }) => input.preferences
)
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  saved = {
    preferences: { ...defaultGitPreferences },
    desktopGit: {
      environment: "native",
      available: true,
      version: "2.52",
      executable: "D:/git.exe",
    },
    agentGit: { environment: "wsl", available: true, version: "2.43", executable: "/usr/bin/git" },
    agentEnvironmentSource: "用户默认",
    repository: false,
    identityEnvironment: "native",
    globalIdentity: {
      name: { value: "User", source: "用户全局 · file:D:/private/config" },
      email: { value: "user@example.com", source: "用户全局 · file:D:/private/config" },
      configuredName: "User",
      configuredEmail: "user@example.com",
    },
    projectIdentity: null,
    worktrees: [],
    errors: [],
  }
  readSnapshot.mockReset().mockImplementation(async () => saved)
  updatePreferences.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      gitSettings: {
        snapshot: readSnapshot,
        updatePreferences,
        chooseDirectory: async () => "D:/worktrees",
      },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<GitSettings />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it.each([
  {
    label: "Git 设置范围",
    option: "示例项目",
    scope: { projectId: "sample", environment: "native" },
  },
  {
    label: "身份所在环境",
    option: "WSL Git",
    scope: { projectId: undefined, environment: "wsl" },
  },
] as const)("replaces the old snapshot when changing $label", async ({ label, option, scope }) => {
  const pending = Promise.withResolvers<GitSettingsSnapshot>()
  readSnapshot.mockReturnValueOnce(pending.promise)
  const displayMode = () => container.querySelector('[aria-label="显示方式"]')
  expect(displayMode()?.textContent).toContain("单栏视图")

  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === option)!
      .click()
  )
  expect(readSnapshot).toHaveBeenLastCalledWith(scope)
  expect(container.querySelector('[role="status"]')?.textContent).toContain("正在检测 Git")
  expect(displayMode()).toBeNull()

  await act(async () =>
    pending.resolve({
      ...saved,
      identityEnvironment: scope.environment,
      preferences: { ...saved.preferences, viewMode: "split" },
    })
  )
  expect(displayMode()?.textContent).toContain("左右对照")
})

it("changes display preferences without overwriting an unsaved branch prefix", async () => {
  container.querySelector<HTMLDetailsElement>("#git-advanced")!.open = true
  const prefix = container.querySelector<HTMLInputElement>('input[placeholder="例如 task/"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      prefix,
      "my-task/"
    )
    prefix.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const selector = container.querySelector<HTMLButtonElement>('[aria-label="显示方式"]')
  expect(selector).not.toBeNull()
  await act(async () => selector!.click())
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === "左右对照")!
      .click()
  )
  expect(updatePreferences).toHaveBeenCalledWith({
    preferences: { ...defaultGitPreferences, viewMode: "split" },
    expected: defaultGitPreferences,
  })
  expect(prefix.value).toBe("my-task/")
  expect(selector!.textContent).toContain("左右对照")
})
it("persists and restores the worktree directory from its title", async () => {
  container.querySelector<HTMLDetailsElement>("#git-advanced")!.open = true
  const reset = () => container.querySelector<HTMLButtonElement>('[aria-label="恢复默认目录位置"]')
  expect(reset()).toBeNull()
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "选择目录")!
      .click()
  )
  expect(updatePreferences).toHaveBeenCalledWith({
    preferences: { ...defaultGitPreferences, worktreeRoot: "D:/worktrees" },
    expected: defaultGitPreferences,
  })
  expect(reset()?.previousElementSibling?.textContent).toBe("目录位置")
  await act(async () => reset()!.click())
  expect(updatePreferences).toHaveBeenLastCalledWith({
    preferences: defaultGitPreferences,
    expected: { ...defaultGitPreferences, worktreeRoot: "D:/worktrees" },
  })
  expect(reset()).toBeNull()
})
it("requires confirmation before enabling automatic directory cleanup", async () => {
  container.querySelector<HTMLDetailsElement>("#git-advanced")!.open = true
  await act(async () =>
    container.querySelector<HTMLElement>('[aria-label="自动清理已结束目录"]')!.click()
  )
  expect(updatePreferences).not.toHaveBeenCalled()
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "确认")!
      .click()
  )
  expect(updatePreferences).toHaveBeenCalledWith({
    preferences: { ...defaultGitPreferences, autoCleanup: true },
    expected: defaultGitPreferences,
  })
})
