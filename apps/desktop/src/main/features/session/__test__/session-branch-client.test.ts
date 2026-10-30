import { beforeEach, describe, expect, it, vi } from "vitest"
import type { VykorClient } from "@vykor/application-client"

const git = vi.hoisted(() => ({ execGit: vi.fn(), uniqueBranch: vi.fn() }))
vi.mock("electron", () => ({
  app: { getPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("../../browser/browser-agent-service", () => ({ browserAgentService: {} }))
vi.mock("../../settings/git-settings-service", () => ({ gitSettingsService: git }))
vi.mock("../project-operations-support", async (importOriginal) => ({
  ...await importOriginal<typeof import("../project-operations-support")>(),
  execGit: git.execGit,
  listLocalBranches: async () => ["main"],
}))

import { DesktopSessionService } from "../session-service"
import { DaemonConnectionService } from "../daemon-connection-service"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function client(id: string): VykorClient {
  return {
    projects: { inspect: async (path: string) => ({ id, path, name: id, lastOpenedAt: 1, createdAt: 1, updatedAt: 1 }) },
    development: { getGitBranch: async () => `Current branch: ${id}` },
  } as unknown as VykorClient
}

beforeEach(() => {
  vi.resetAllMocks()
  git.uniqueBranch.mockImplementation(async (_path: string, branch: string) => branch)
})

describe("branch operations keep their calling client", () => {
  // Replacing a shared client while Git is pending must not redirect the project read.
  it.each(["checkoutProjectBranch", "createProjectBranch"] as const)(
    "%s keeps its client when another branch operation overlaps",
    async (firstMethod) => {
      const connection = new DaemonConnectionService()
      vi.spyOn(connection, "getClient")
        .mockResolvedValueOnce(client("first"))
        .mockResolvedValueOnce(client("second"))
      const service = new DesktopSessionService(connection)
      const firstGit = deferred<{ stdout: string; stderr: string }>()
      const secondGit = deferred<{ stdout: string; stderr: string }>()
      const firstStarted = deferred<void>()
      const secondStarted = deferred<void>()
      git.execGit.mockImplementation(async (_path: string, args: string[]) => {
        if (args[0] !== "switch") return { stdout: "", stderr: "" }
        if (args.at(-1) === "first") {
          firstStarted.resolve()
          return firstGit.promise
        }
        secondStarted.resolve()
        return secondGit.promise
      })
      const secondMethod = firstMethod === "checkoutProjectBranch"
        ? "createProjectBranch" : "checkoutProjectBranch"
      const first = service[firstMethod]({ path: process.cwd(), branch: "first" })
      await firstStarted.promise
      const second = service[secondMethod]({ path: process.cwd(), branch: "second" })
      await secondStarted.promise

      firstGit.resolve({ stdout: "", stderr: "" })
      secondGit.resolve({ stdout: "", stderr: "" })
      const results = await Promise.all([first, second])
      expect(results.map(({ project, branch }) => [project.id, branch])).toEqual([
        ["first", "first"], ["second", "second"],
      ])
    }
  )

  it("keeps a later call's client when an earlier connection resolves late", async () => {
    const connection = new DaemonConnectionService()
    const lateClient = deferred<VykorClient>()
    vi.spyOn(connection, "getClient")
      .mockReturnValueOnce(lateClient.promise)
      .mockResolvedValueOnce(client("second"))
    const service = new DesktopSessionService(connection)
    const pendingGit = new Map([
      ["first", deferred<{ stdout: string; stderr: string }>()],
      ["second", deferred<{ stdout: string; stderr: string }>()],
    ])
    const started = new Map([["first", deferred<void>()], ["second", deferred<void>()]])
    git.execGit.mockImplementation(async (_path: string, args: string[]) => {
      if (args[0] !== "switch") return { stdout: "", stderr: "" }
      const branch = args.at(-1)!
      started.get(branch)!.resolve()
      return pendingGit.get(branch)!.promise
    })
    const first = service.checkoutProjectBranch({ path: process.cwd(), branch: "first" })
    const second = service.createProjectBranch({ path: process.cwd(), branch: "second" })
    await started.get("second")!.promise
    lateClient.resolve(client("first"))
    await started.get("first")!.promise
    pendingGit.get("second")!.resolve({ stdout: "", stderr: "" })
    pendingGit.get("first")!.resolve({ stdout: "", stderr: "" })

    const results = await Promise.all([first, second])
    expect(results.map(({ project, branch }) => [project.id, branch])).toEqual([
      ["first", "first"], ["second", "second"],
    ])
  })
})
