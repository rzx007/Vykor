import { beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpTransport, VykorClient } from "@rzx/client"
import { startVykorDaemon } from "@vykor/server/daemon-host"
import { gitSettingsService } from "../settings/git-settings-service"
const send = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())
vi.mock("electron", () => ({
  app: { getPath: () => "D:/test", getVersion: () => "1" },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [{ webContents: { isDestroyed: () => false, send } }],
  },
  dialog: { showOpenDialog },
  clipboard: {},
  shell: {},
}))
vi.mock("../browser/browser-agent-service", () => ({ browserAgentService: {} }))
import { DesktopSessionService, desktopSessionService } from "./session-service"
import { DaemonConnectionService } from "./daemon-connection-service"
import { ProjectResource } from "./project-resource"
import { workspaceService } from "../workspace/workspace-service"
beforeEach(() => vi.clearAllMocks())

it("chooses, lists and previews a real local directory with no daemon connection", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "vykor-offline-workspace-"))
  try {
    await writeFile(join(rootPath, "offline.txt"), "available offline")
    const { service } = serviceWithConnection()
    const transport = vi.spyOn(service, "daemonTransport").mockRejectedValue(new Error("daemon stopped"))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [rootPath] })

    const selected = await service.chooseProject({} as never)
    expect(selected).toMatchObject({ path: rootPath })
    expect(await workspaceService.listFiles({ rootPath })).toMatchObject({
      entries: [{ path: "offline.txt", type: "file" }],
    })
    expect(await workspaceService.readFile({ rootPath, path: "offline.txt" })).toMatchObject({
      content: "available offline",
    })
    expect(transport).not.toHaveBeenCalled()
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})

it("lists and previews the session working directory through the SDK and a running daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "vykor-session-files-"))
  let daemon: Awaited<ReturnType<typeof startVykorDaemon>> | undefined
  let agentClient: ReturnType<typeof vi.spyOn> | undefined
  try {
    const project = join(root, "project")
    const sessionDirectory = join(project, "task")
    await mkdir(project)
    await mkdir(join(sessionDirectory, "nested"), { recursive: true })
    await writeFile(join(project, "same.txt"), "project version")
    await writeFile(join(project, "project-only.txt"), "")
    await writeFile(join(sessionDirectory, "same.txt"), "agent version")
    await writeFile(join(sessionDirectory, "nested", "agent-only.txt"), "")

    daemon = await startVykorDaemon({
      host: "127.0.0.1", port: 0, storePath: join(root, "test.db"), logger: () => {},
    })
    const options = { baseUrl: daemon.listen.url }
    const client = new VykorClient(options)
    const { id: projectId } = await new ProjectResource(new HttpTransport(options)).inspect(project)
    const session = await client.sessions.create({
      projectId, cwd: sessionDirectory, model: "fixture", metadata: { runtime: { disallowedTools: ["Glob"] } },
    })
    agentClient = vi.spyOn(desktopSessionService, "agentClient").mockResolvedValue(client)

    const localListing = await workspaceService.listFiles({ rootPath: project })
    expect(localListing.entries).toContainEqual(expect.objectContaining({ path: "project-only.txt" }))
    const listing = await workspaceService.listFiles({ sessionId: session.id })
    expect(listing.entries.map((entry) => entry.path)).toEqual(["nested/", "same.txt"])
    expect((await workspaceService.listFiles({ sessionId: session.id, path: "nested" })).entries)
      .toMatchObject([{ path: "nested/agent-only.txt", type: "file" }])
    expect(await workspaceService.readFile({ sessionId: session.id, path: "same.txt" })).toMatchObject({
      scope: "session", content: "agent version", truncated: false,
    })

    await daemon.server.close()
    await expect(workspaceService.listFiles({ sessionId: session.id })).rejects.toThrow()
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [project] })
    expect(await desktopSessionService.chooseProject({} as never)).toMatchObject({ path: project })
    expect(await workspaceService.listFiles({ rootPath: project })).toEqual(localListing)
    expect(await workspaceService.readFile({ rootPath: project, path: "same.txt" })).toMatchObject({
      content: "project version",
    })
  } finally {
    agentClient?.mockRestore()
    await daemon?.server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("creates a Desktop Git worktree session and reads that worktree through the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "vykor-worktree-session-"))
  let daemon: Awaited<ReturnType<typeof startVykorDaemon>> | undefined
  const mocks: Array<{ mockRestore(): void }> = []
  try {
    vi.stubEnv("VYKOR_AGENT_ENVIRONMENT", "native")
    const project = join(root, "project")
    await mkdir(project)
    const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { windowsHide: true, stdio: "pipe" })
    git("init", "--quiet")
    await writeFile(join(project, "same.txt"), "project version")
    git("add", ".")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "fixture")

    daemon = await startVykorDaemon({
      host: "127.0.0.1", port: 0, storePath: join(root, "test.db"), logger: () => {},
    })
    const options = { baseUrl: daemon.listen.url }
    const client = new VykorClient(options)
    const transport = new HttpTransport(options)
    mocks.push(vi.spyOn(desktopSessionService, "agentClient").mockResolvedValue(client))
    mocks.push(vi.spyOn(desktopSessionService, "daemonTransport").mockResolvedValue(transport))
    const { id: projectId } = await new ProjectResource(transport).inspect(project)
    const bind = gitSettingsService.bindTaskWorktree.bind(gitSettingsService)
    let duplicateError: unknown
    const binding = vi.spyOn(gitSettingsService, "bindTaskWorktree").mockImplementationOnce(async (id, sessionId) => {
      const assigned = await client.sessions.get(sessionId)
      await client.sessions.create({
        projectId, cwd: assigned.cwd, model: "fixture", metadata: assigned.metadata,
      }).catch((error: unknown) => { duplicateError = error })
      bind(id, sessionId)
    })
    mocks.push(binding)

    const session = await desktopSessionService.createSession({
      projectId, cwd: project, model: "fixture", taskLocation: "worktree",
    })
    expect(duplicateError).toMatchObject({ message: "Session cwd must be within the project directory" })
    expect(session.projectId).toBe(projectId)
    expect(session.cwd).not.toBe(project)
    await writeFile(join(session.cwd, "same.txt"), "worktree version")
    await writeFile(join(session.cwd, "worktree-only.txt"), "")
    expect((await workspaceService.listFiles({ sessionId: session.id })).entries)
      .toContainEqual(expect.objectContaining({ path: "worktree-only.txt" }))
    expect(await workspaceService.readFile({ sessionId: session.id, path: "same.txt" }))
      .toMatchObject({ content: "worktree version" })
    await expect(client.sessions.create({
      projectId, cwd: session.cwd, model: "fixture", metadata: session.metadata,
    })).rejects.toThrow("Session cwd must be within the project directory")
  } finally {
    for (const mock of mocks) mock.mockRestore()
    vi.unstubAllEnvs()
    await daemon?.server.close()
    await rm(root, { recursive: true, force: true })
  }
})
describe("retired database-only switch", () => {
  it("rejects old parameters before invalidating subscriptions or reaching the backend", async () => {
    const { service, connection } = serviceWithConnection()
    const clear = vi.spyOn(service.subscriptions, "clearAll")
    const backend = vi.spyOn(connection, "switchDataDirectory")
    await expect(service.switchDataDirectory("D:/target", { storePath: "D:/target/sessions.db" })).rejects.toThrow(/用户数据根.*迁移/)
    expect(clear).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

function serviceWithConnection() {
  const connection = new DaemonConnectionService()
  const listeners = new Set<() => void>()
  vi.spyOn(connection, "onInvalidated").mockImplementation((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  return {
    service: new DesktopSessionService(connection),
    connection,
    invalidate: () => { for (const listener of listeners) listener() },
  }
}
