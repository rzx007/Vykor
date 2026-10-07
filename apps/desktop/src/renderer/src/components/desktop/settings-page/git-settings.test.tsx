// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { defaultGitPreferences, type GitSettingsSnapshot } from "@shared/git-settings-types"
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (select: (state: unknown) => unknown) => select({ projects: [] }),
}))
import { GitSettings } from "./git-settings"
let container: HTMLDivElement, root: Root, saved: GitSettingsSnapshot
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
  updatePreferences.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      gitSettings: {
        snapshot: async () => saved,
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
it("persists a chosen worktree directory instead of dropping a nested operation", async () => {
  container.querySelector<HTMLDetailsElement>("#git-advanced")!.open = true
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "选择目录")!
      .click()
  )
  expect(updatePreferences).toHaveBeenCalledWith({
    preferences: { ...defaultGitPreferences, worktreeRoot: "D:/worktrees" },
    expected: defaultGitPreferences,
  })
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
