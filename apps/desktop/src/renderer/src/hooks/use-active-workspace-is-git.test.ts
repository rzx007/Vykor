// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"

import { resetWorkspaceGitProbeCacheForTests } from "@renderer/lib/workspace-git-probe"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

import { useActiveWorkspaceIsGit } from "./use-active-workspace-is-git"

const initialStoreState = useDesktopSessionStore.getState()
const initialDesktop = Reflect.get(window, "desktop")
const unmounts: Array<() => void> = []

function renderIsGit(): { read: () => boolean | null; unmount: () => void } {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const snapshot: { current: boolean | null } = { current: null }

  function Probe(): null {
    snapshot.current = useActiveWorkspaceIsGit()
    return null
  }

  act(() => {
    root.render(createElement(Probe))
  })

  const unmount = (): void => {
    act(() => root.unmount())
    container.remove()
  }
  unmounts.push(unmount)

  return { read: () => snapshot.current, unmount }
}

function outsideProjectSessionView(id = "s1", cwd = "D:/xm"): DesktopSessionView {
  const view = emptySessionView(id)
  return {
    ...view,
    session: { ...view.session, cwd, workspaceMode: "outside_project" },
  }
}

function installProbe(
  isRepository: (options: { path: string }) => Promise<{ isRepository: boolean; rootPath: null }>
): ReturnType<typeof vi.fn<typeof isRepository>> {
  const probe = vi.fn(isRepository)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { isRepository: probe } },
  })
  return probe
}

describe("useActiveWorkspaceIsGit", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    useDesktopSessionStore.setState(initialStoreState, true)
    resetWorkspaceGitProbeCacheForTests()
  })

  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
    useDesktopSessionStore.setState(initialStoreState, true)
    resetWorkspaceGitProbeCacheForTests()
    vi.restoreAllMocks()
    if (initialDesktop === undefined) Reflect.deleteProperty(window, "desktop")
    else
      Object.defineProperty(window, "desktop", {
        configurable: true,
        value: initialDesktop,
      })
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  })

  it("uses selectedProjectGit for a project session without probing", async () => {
    const isRepository = installProbe(async () => ({ isRepository: true, rootPath: null }))
    useDesktopSessionStore.setState({
      selectedProject: {
        id: "p1",
        name: "repo",
        path: "D:/repo",
        lastOpenedAt: 1,
        available: true,
      },
      selectedProjectGit: true,
      activeSessionId: null,
    })

    const view = renderIsGit()
    await act(async () => {})

    expect(view.read()).toBe(true)
    expect(isRepository).not.toHaveBeenCalled()
  })

  it("probes the session cwd for an outside-project session", async () => {
    const isRepository = installProbe(async () => ({ isRepository: true, rootPath: null }))
    useDesktopSessionStore.setState({
      selectedProject: null,
      selectedProjectGit: false,
      activeSessionId: "s1",
      sessionView: outsideProjectSessionView(),
    })

    const view = renderIsGit()
    await act(async () => {})

    expect(view.read()).toBe(true)
    expect(isRepository).toHaveBeenCalledWith({ path: "D:/xm" })
  })

  it("returns false when the probe reports a non-repository", async () => {
    const isRepository = installProbe(async () => ({ isRepository: false, rootPath: null }))
    useDesktopSessionStore.setState({
      selectedProject: null,
      selectedProjectGit: false,
      activeSessionId: "s1",
      sessionView: outsideProjectSessionView(),
    })

    const view = renderIsGit()
    await act(async () => {})

    expect(view.read()).toBe(false)
    expect(isRepository).toHaveBeenCalledWith({ path: "D:/xm" })
  })

  it("returns null while an outside-project probe is still pending", () => {
    installProbe(() => new Promise(() => {}))
    useDesktopSessionStore.setState({
      selectedProject: null,
      selectedProjectGit: false,
      activeSessionId: "s1",
      sessionView: outsideProjectSessionView(),
    })

    const view = renderIsGit()

    expect(view.read()).toBeNull()
  })

  it("returns null immediately after switching to another outside-project path with a pending probe", async () => {
    const pending = new Promise<{ isRepository: boolean; rootPath: null }>(() => {})
    const isRepository = vi.fn(async ({ path }: { path: string }) => {
      if (path === "D:/one") return { isRepository: true, rootPath: null }
      return pending
    })
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { isRepository } },
    })
    useDesktopSessionStore.setState({
      selectedProject: null,
      selectedProjectGit: false,
      activeSessionId: "s1",
      sessionView: outsideProjectSessionView("s1", "D:/one"),
    })

    const view = renderIsGit()
    await act(async () => {})
    expect(view.read()).toBe(true)

    act(() => {
      useDesktopSessionStore.setState({
        activeSessionId: "s2",
        sessionView: outsideProjectSessionView("s2", "D:/two"),
      })
    })

    expect(isRepository).toHaveBeenCalledWith({ path: "D:/two" })
    expect(view.read()).toBeNull()

    await act(async () => {})
    expect(view.read()).toBeNull()
  })

  it("returns false when there is no active workspace", async () => {
    const isRepository = installProbe(async () => ({ isRepository: true, rootPath: null }))
    useDesktopSessionStore.setState({
      selectedProject: null,
      selectedProjectGit: false,
      activeSessionId: null,
      sessionView: null,
    })

    const view = renderIsGit()
    await act(async () => {})

    expect(view.read()).toBe(false)
    expect(isRepository).not.toHaveBeenCalled()
  })
})
