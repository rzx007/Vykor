import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDesktopSessionStore } from "./store"
import { createEmptySessionRuntime } from "./operation-state"
import {
  emptySessionView,
  projectDetails,
  refreshedBootstrap,
  resetDesktopSessionStore,
} from "./store-test-fixtures"

beforeEach(() => {
  resetDesktopSessionStore()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("desktop session store provider refresh", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          bootstrap: vi.fn(async () => refreshedBootstrap),
        },
      },
    })
    useDesktopSessionStore.setState({
      loadStatus: "ready",
      activeSessionId: null,
      sessionView: null,
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          provider: "OpenAI",
          providerName: "openai",
        },
      ],
      defaultModel: "gpt-5.4",
      defaultProvider: "openai",
      selectedModel: "gpt-5.4",
      selectedProvider: "openai",
    })
  })

  it("refreshes the new-conversation provider and model after settings change", async () => {
    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      models: refreshedBootstrap.models,
      attachmentSupport: refreshedBootstrap.attachments,
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedModel: "deepseek-chat",
      selectedProvider: "deepseek",
    })
  })

  it("keeps the open session runtime selection while refreshing global defaults", async () => {
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      selectedPermissionMode: "plan",
    })

    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      models: refreshedBootstrap.models,
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedModel: "gpt-5.4",
      selectedProvider: "openai",
      selectedPermissionMode: "plan",
    })
  })

  it("keeps the outside-project selection while refreshing settings", async () => {
    useDesktopSessionStore.setState({
      workspaceMode: "outside_project",
      selectedProject: null,
    })

    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
    })
  })
})

describe("desktop session store project order", () => {
  it("refreshes session cwd after project rebind", async () => {
    const project = { id: "project-rebind", name: "Rebind", path: "D:\\old", lastOpenedAt: 1, available: true }
    const rebound = { ...project, path: "D:\\new" }
    const oldSession = { id: "s1", projectId: project.id, cwd: "D:\\old\\sub", title: "test", model: "test", status: "idle" as const, metadata: {}, createdAt: 1, updatedAt: 1 }
    vi.stubGlobal("window", { desktop: { sessions: {
      rebindProject: async () => rebound,
      bootstrap: async () => ({ ...refreshedBootstrap, projects: [rebound], sessions: [{ ...oldSession, cwd: "D:\\new\\sub" }] }),
    } } })
    useDesktopSessionStore.setState({ projects: [project], sessions: [oldSession], selectedProject: project })
    await useDesktopSessionStore.getState().rebindProject(project.id)
    expect(useDesktopSessionStore.getState().sessions[0]?.cwd).toBe("D:\\new\\sub")
  })
  it("keeps the project list stable when selecting a project", async () => {
    const projects = [
      {
        id: "project-a",
        name: "Project A",
        path: "D:\\code\\project-a",
        lastOpenedAt: 300,
        available: true,
      },
      {
        id: "project-b",
        name: "Project B",
        path: "D:\\code\\project-b",
        lastOpenedAt: 200,
        available: true,
      },
      {
        id: "project-c",
        name: "Project C",
        path: "D:\\code\\project-c",
        lastOpenedAt: 100,
        available: true,
      },
    ]
    const inspectedProject = { ...projects[1], lastOpenedAt: 400 }
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(async () => ({
            project: inspectedProject,
            git: false,
            branch: null,
            branches: [],
          })),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects,
      workspaceMode: "project",
      selectedProject: projects[0],
      selectedProjectGit: false,
      branch: null,
      branches: [],
    })

    await useDesktopSessionStore.getState().selectProject(projects[1])

    expect(useDesktopSessionStore.getState().projects.map((project) => project.id)).toEqual([
      "project-a",
      "project-b",
      "project-c",
    ])
    expect(useDesktopSessionStore.getState().projects[1]).toEqual(inspectedProject)
  })

  it("keeps a project operation failure out of the active session runtime", async () => {
    const project = {
      id: "project-unavailable",
      name: "Unavailable Project",
      path: "D:\\code\\project-unavailable",
      lastOpenedAt: 100,
      available: true,
    }
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(async () => {
            throw new Error("project unavailable")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "s1",
      sessionRuntimes: { s1: createEmptySessionRuntime() },
      projectOperations: {},
    })

    await expect(useDesktopSessionStore.getState().selectProject(project)).rejects.toThrow(
      "project unavailable"
    )

    expect(useDesktopSessionStore.getState().sessionRuntimes.s1?.operations).toEqual({})
    expect(
      Object.values(useDesktopSessionStore.getState().projectOperations[project.id] ?? {})
    ).toContainEqual(expect.objectContaining({ phase: "failed", error: "project unavailable" }))
  })

  it("clears only a retried action's failure after that action succeeds", async () => {
    const project = {
      id: "project-retry",
      name: "Retry Project",
      path: "D:\\code\\project-retry",
      lastOpenedAt: 100,
      available: true,
    }
    const inspectProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("inspect unavailable"))
      .mockResolvedValueOnce(projectDetails(project, "main"))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
          checkoutBranch: vi.fn(async () => {
            throw new Error("checkout unavailable")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      selectedProject: project,
      projectOperations: {},
    })

    await expect(useDesktopSessionStore.getState().checkoutBranch("feature/retry")).rejects.toThrow(
      "checkout unavailable"
    )
    await expect(useDesktopSessionStore.getState().selectProject(project)).rejects.toThrow(
      "inspect unavailable"
    )
    await useDesktopSessionStore.getState().selectProject(project)

    const operations = Object.values(
      useDesktopSessionStore.getState().projectOperations[project.id] ?? {}
    )
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ phase: "failed", error: "checkout unavailable" })
  })

  it("clears a removed project's operation bucket", async () => {
    const project = {
      id: "project-remove",
      name: "Removed Project",
      path: "D:\\code\\project-remove",
      lastOpenedAt: 100,
      available: true,
    }
    vi.stubGlobal("window", {
      desktop: { sessions: { removeProject: vi.fn(async () => undefined) } },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      selectedProject: null,
      projectOperations: {},
    })

    await useDesktopSessionStore.getState().removeProject(project.path)

    expect(useDesktopSessionStore.getState().projectOperations[project.id]).toBeUndefined()
  })

  it("does not let a late project selection replace the newer selection", async () => {
    const projectA = {
      id: "project-a",
      name: "Project A",
      path: "D:\\code\\project-a",
      lastOpenedAt: 100,
      available: true,
    }
    const projectB = {
      id: "project-b",
      name: "Project B",
      path: "D:\\code\\project-b",
      lastOpenedAt: 200,
      available: true,
    }
    let resolveA!: (value: ReturnType<typeof projectDetails>) => void
    let resolveB!: (value: ReturnType<typeof projectDetails>) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(
            (path: string) =>
              new Promise((resolve) => {
                if (path === projectA.path) resolveA = resolve
                else resolveB = resolve
              })
          ),
        },
      },
    })
    useDesktopSessionStore.setState({ projects: [projectA, projectB], projectOperations: {} })

    const selectingA = useDesktopSessionStore.getState().selectProject(projectA)
    const selectingB = useDesktopSessionStore.getState().selectProject(projectB)
    resolveB(projectDetails(projectB, "branch-b"))
    await selectingB
    resolveA(projectDetails(projectA, "branch-a"))
    await selectingA

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProject: projectB,
      branch: "branch-b",
      branches: ["branch-b"],
    })
  })

  it.each([
    ["checkoutBranch", "checkoutBranch"],
    ["createAndCheckoutBranch", "createBranch"],
  ] as const)(
    "does not let a late %s response replace the current project",
    async (action, ipcMethod): Promise<void> => {
      const projectA = {
        id: "project-branch-a",
        name: "Project Branch A",
        path: "D:\\code\\project-branch-a",
        lastOpenedAt: 100,
        available: true,
      }
      const projectB = {
        id: "project-branch-b",
        name: "Project Branch B",
        path: "D:\\code\\project-branch-b",
        lastOpenedAt: 200,
        available: true,
      }
      let resolveBranch!: (value: ReturnType<typeof projectDetails>) => void
      vi.stubGlobal("window", {
        desktop: {
          sessions: {
            inspectProject: vi.fn(async () => projectDetails(projectB, "branch-b")),
            [ipcMethod]: vi.fn(
              () =>
                new Promise((resolve) => {
                  resolveBranch = resolve
                })
            ),
          },
        },
      })
      useDesktopSessionStore.setState({
        projects: [projectA, projectB],
        selectedProject: projectA,
        branch: "branch-a",
        branches: ["branch-a"],
        projectOperations: {},
      })

      const changingBranch = useDesktopSessionStore.getState()[action]("feature/late")
      await useDesktopSessionStore.getState().selectProject(projectB)
      resolveBranch(projectDetails(projectA, "feature/late"))
      await changingBranch

      expect(useDesktopSessionStore.getState()).toMatchObject({
        selectedProject: projectB,
        branch: "branch-b",
        branches: ["branch-b"],
      })
    }
  )

  it("does not let an older refresh overwrite a newer checkout for the selected project", async () => {
    const project = {
      id: "project-refresh-checkout",
      name: "Project Refresh Checkout",
      path: "D:\\code\\project-refresh-checkout",
      lastOpenedAt: 100,
      available: true,
    }
    let resolveRefresh!: (value: ReturnType<typeof projectDetails>) => void
    const inspectProject = vi.fn(
      () =>
        new Promise<ReturnType<typeof projectDetails>>((resolve) => {
          resolveRefresh = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
          checkoutBranch: vi.fn(async () => projectDetails(project, "feature/new")),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: true,
      selectedProjectGitCheckedAt: null,
      branch: "main",
      branches: ["main"],
      projectOperations: {},
    })

    const refresh = useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    await useDesktopSessionStore.getState().checkoutBranch("feature/new")
    resolveRefresh(projectDetails(project, "main"))
    await refresh

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProject: project,
      branch: "feature/new",
      branches: ["feature/new"],
    })
  })

  it("does not surface a stale refresh failure after a newer checkout succeeds", async () => {
    const project = {
      id: "project-stale-refresh-error",
      name: "Project Stale Refresh Error",
      path: "D:\\code\\project-stale-refresh-error",
      lastOpenedAt: 100,
      available: true,
    }
    let rejectRefresh!: (error: Error) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(
            () =>
              new Promise<ReturnType<typeof projectDetails>>((_resolve, reject) => {
                rejectRefresh = reject
              })
          ),
          checkoutBranch: vi.fn(async () => projectDetails(project, "feature/new")),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: true,
      selectedProjectGitCheckedAt: null,
      branch: "main",
      branches: ["main"],
      projectOperations: {},
    })

    const refresh = useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    await useDesktopSessionStore.getState().checkoutBranch("feature/new")
    rejectRefresh(new Error("stale refresh failed"))
    await refresh

    expect(useDesktopSessionStore.getState()).toMatchObject({
      branch: "feature/new",
      branches: ["feature/new"],
    })
    expect(useDesktopSessionStore.getState().projectOperations[project.id]).toBeUndefined()
  })

  it("does not surface a stale checkout failure after a newer refresh succeeds", async () => {
    const project = {
      id: "project-stale-checkout-error",
      name: "Project Stale Checkout Error",
      path: "D:\\code\\project-stale-checkout-error",
      lastOpenedAt: 100,
      available: true,
    }
    let rejectCheckout!: (error: Error) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          checkoutBranch: vi.fn(
            () =>
              new Promise<ReturnType<typeof projectDetails>>((_resolve, reject) => {
                rejectCheckout = reject
              })
          ),
          inspectProject: vi.fn(async () => projectDetails(project, "feature/refreshed")),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: true,
      selectedProjectGitCheckedAt: null,
      branch: "main",
      branches: ["main"],
      projectOperations: {},
    })

    const checkout = useDesktopSessionStore.getState().checkoutBranch("feature/stale")
    await useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    rejectCheckout(new Error("stale checkout failed"))
    await checkout

    expect(useDesktopSessionStore.getState()).toMatchObject({
      branch: "feature/refreshed",
      branches: ["feature/refreshed"],
    })
    expect(useDesktopSessionStore.getState().projectOperations[project.id]).toBeUndefined()
  })

  it("does not let a late chooser replace a newer explicit project selection", async () => {
    const projectA = {
      id: "project-choose-a",
      name: "Project Choose A",
      path: "D:\\code\\project-choose-a",
      lastOpenedAt: 100,
      available: true,
    }
    const projectB = {
      id: "project-select-b",
      name: "Project Select B",
      path: "D:\\code\\project-select-b",
      lastOpenedAt: 200,
      available: true,
    }
    let resolveChoose!: (value: ReturnType<typeof projectDetails>) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          chooseProject: vi.fn(
            () =>
              new Promise<ReturnType<typeof projectDetails>>((resolve) => (resolveChoose = resolve))
          ),
          inspectProject: vi.fn(async () => projectDetails(projectB, "branch-b")),
        },
      },
    })
    useDesktopSessionStore.setState({ projects: [projectA, projectB], projectOperations: {} })

    const choosing = useDesktopSessionStore.getState().chooseProject()
    await useDesktopSessionStore.getState().selectProject(projectB)
    resolveChoose(projectDetails(projectA, "branch-a"))
    await choosing

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProject: projectB,
      branch: "branch-b",
      branches: ["branch-b"],
    })
  })

  it("does not let the first of two forced refreshes overwrite the second", async () => {
    const project = {
      id: "project-refresh-order",
      name: "Project Refresh Order",
      path: "D:\\code\\project-refresh-order",
      lastOpenedAt: 100,
      available: true,
    }
    const resolvers: Array<(value: ReturnType<typeof projectDetails>) => void> = []
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(
            () =>
              new Promise<ReturnType<typeof projectDetails>>((resolve) => {
                resolvers.push(resolve)
              })
          ),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: true,
      selectedProjectGitCheckedAt: null,
      branch: "main",
      branches: ["main"],
      projectOperations: {},
    })

    const first = useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    const second = useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    resolvers[1]!(projectDetails(project, "newer"))
    await second
    resolvers[0]!(projectDetails(project, "older"))
    await first

    expect(useDesktopSessionStore.getState()).toMatchObject({
      branch: "newer",
      branches: ["newer"],
    })
  })
})

describe("desktop session store bootstrap operations", () => {
  it("records a refresh bootstrap failure in app operations", async () => {
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          bootstrap: vi.fn(async () => {
            throw new Error("bootstrap refresh unavailable")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({ appOperations: {} })

    await expect(useDesktopSessionStore.getState().refreshBootstrap()).rejects.toThrow(
      "bootstrap refresh unavailable"
    )

    expect(Object.values(useDesktopSessionStore.getState().appOperations)).toContainEqual(
      expect.objectContaining({ phase: "failed", error: "bootstrap refresh unavailable" })
    )
  })

  it("keeps initialize's app operation until a restored session fails", async () => {
    const restoredSession = emptySessionView("restored-session").session
    const openSession = useDesktopSessionStore.getState().openSession
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => restoredSession.id),
      removeItem: vi.fn(),
    })
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          daemonStatus: vi.fn(async () => ({ phase: "ready", message: "ready", updatedAt: 1 })),
          bootstrap: vi.fn(async () => ({ ...refreshedBootstrap, sessions: [restoredSession] })),
          onDaemonStatusChanged: vi.fn(),
        },
      },
    })
    useDesktopSessionStore.setState({
      loadStatus: "idle",
      appOperations: {},
      openSession: vi.fn(async () => {
        throw new Error("restore unavailable")
      }),
    })

    try {
      await useDesktopSessionStore.getState().initialize()

      expect(Object.values(useDesktopSessionStore.getState().appOperations)).toContainEqual(
        expect.objectContaining({ phase: "failed", error: "restore unavailable" })
      )
    } finally {
      useDesktopSessionStore.setState({ openSession })
      vi.unstubAllGlobals()
    }
  })
})

describe("desktop session store git state refresh", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses the git cache until a forced refresh is requested", async () => {
    const project = {
      id: "project-a",
      name: "Project A",
      path: "D:\\code\\project-a",
      lastOpenedAt: 100,
      available: true,
    }
    const inspectProject = vi.fn(async () => ({
      project,
      git: true,
      branch: "main",
      branches: ["main"],
    }))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: false,
      selectedProjectGitCheckedAt: Date.now(),
      branch: null,
      branches: [],
    })

    await expect(useDesktopSessionStore.getState().refreshSelectedProjectGit()).resolves.toBe(false)
    expect(inspectProject).not.toHaveBeenCalled()

    await expect(
      useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    ).resolves.toBe(true)

    expect(inspectProject).toHaveBeenCalledWith(project.path)
    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProjectGit: true,
      branch: "main",
      branches: ["main"],
    })
  })

  it("refreshes a previously non-git project after session updates", async () => {
    vi.useFakeTimers()
    const project = {
      id: "project-a",
      name: "Project A",
      path: "D:\\code\\project-a",
      lastOpenedAt: 100,
      available: true,
    }
    const inspectProject = vi.fn(async () => ({
      project,
      git: true,
      branch: "main",
      branches: ["main"],
    }))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: false,
      selectedProjectGitCheckedAt: Date.now(),
      branch: null,
      branches: [],
      activeSessionId: "session-1",
      sessionView: null,
    })

    useDesktopSessionStore.getState().applySessionUpdate({
      cursor: 1,
      syncStatus: "connected",
      session: {
        id: "session-1",
        projectId: project.id,
        workspaceMode: "project",
        cwd: project.path,
        title: "Git init",
        model: "deepseek-chat",
        status: "idle",
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      },
      inputs: [],
      messages: [],
      parts: [],
      runs: [],
      tasks: [],
      permissions: [],
    })
    await vi.advanceTimersByTimeAsync(750)

    expect(inspectProject).toHaveBeenCalledWith(project.path)
    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProjectGit: true,
      branch: "main",
      branches: ["main"],
    })
  })
})
