import { beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpTransport, VykorClient, type SessionStateSnapshot } from "@rzx/client"
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
import { ComputerPromptNotSubmittedError } from "../computer/computer-bridge"
import { ProjectResource } from "./project-resource"
import { workspaceService } from "../workspace/workspace-service"
beforeEach(() => vi.clearAllMocks())

it("revokes the exact Computer run synchronously before Chat Stop connects to the daemon", async () => {
  const { service, connection } = serviceWithConnection()
  const revoke = vi.spyOn(connection, "revokeComputerRun")
  const connect = vi.spyOn(service, "agentClient").mockRejectedValue(new Error("daemon offline"))
  const pending = service.interruptSession({ sessionId: "session", expectedRunId: "run" })
  expect(revoke).toHaveBeenCalledExactlyOnceWith("session", "run")
  expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!)
  await expect(pending).rejects.toThrow(/daemon offline/)
})

it("does not submit a preparing Computer prompt after an untargeted Chat Stop", async () => {
  const { service, connection } = serviceWithConnection()
  vi.spyOn(service.subscriptions, "getOwnerSessionId").mockReturnValue("session")
  vi.spyOn(service, "agentClient").mockRejectedValue(new Error("daemon offline"))
  let finishPreparation!: () => void
  const preparing = new Promise<void>(resolve => { finishPreparation = resolve })
  const submit = vi.fn()
  vi.spyOn(connection, "getComputerBridge").mockImplementation(async authorize => {
    await preparing
    authorize()
    return { submit } as never
  })
  const request = service.sendComputerPrompt({ id: 43 } as never, {
    id: "input", sessionId: "session", items: [{ type: "text", text: "打开记事本" }], attachments: [],
  }, () => {}, new AbortController().signal)
  await expect(service.interruptSession({ sessionId: "session" })).rejects.toThrow(/daemon offline/)
  const rejected = expect(request).rejects.toThrow(/电脑操作已停止/)
  finishPreparation()
  await rejected
  expect(submit).not.toHaveBeenCalled()
})

it.each([undefined, true] as const)("waits for its replacement snapshot when the first Computer request pairs the daemon (automatic=%s)", async automatic => {
  const h = await pairingPrompt(automatic)
  try {
    await h.reset
    const opening = h.openReplacement()
    await Promise.resolve()
    expect(h.submit).not.toHaveBeenCalled()
    h.restore.resolve(h.snapshot)
    await opening
    await expect(h.request).resolves.toBeUndefined()
    expect(h.submit).toHaveBeenCalledExactlyOnceWith("session", expect.objectContaining({ id: "input" }),
      expect.any(Function), expect.any(AbortSignal), ...(automatic ? [true, expect.any(AbortSignal)] : []))
  } finally {
    h.cleanup()
  }
})

it("finishes an automatic message receipt after switching chats while revoking its Computer view", async () => {
  const { service, connection } = serviceWithConnection()
  vi.spyOn(service.subscriptions, "getOwnerSessionId").mockReturnValue("session")
  const pending = Promise.withResolvers<void>()
  const submit = vi.fn(() => pending.promise)
  vi.spyOn(connection, "getComputerBridge").mockResolvedValue({ submit } as never)
  const invalidated = vi.spyOn(connection, "invalidateComputerView")
  const request = service.sendComputerPrompt({ id: 43 } as never, {
    id: "ordinary", sessionId: "session", items: [{ type: "text", text: "打开记事本" }], attachments: [],
  }, () => {}, new AbortController().signal, undefined, true)
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
  const call = submit.mock.calls[0] as unknown as [unknown, unknown, unknown, AbortSignal, true, AbortSignal]
  service.invalidateComputerView("other")
  expect(call[3].aborted).toBe(true)
  expect(call[5].aborted).toBe(false)
  expect(invalidated).toHaveBeenCalledExactlyOnceWith("other")
  pending.resolve()
  await expect(request).resolves.toBeUndefined()
})

it.each(["hidden", "before-submit", "uncertain-submit", "stop"] as const)(
  "preserves the ordinary message only when no Computer request was submitted (%s)", async phase => {
    const { service, connection } = serviceWithConnection()
    vi.spyOn(service.subscriptions, "getOwnerSessionId").mockReturnValue("session")
    const plain = vi.fn().mockResolvedValue({})
    vi.spyOn(service, "agentClient").mockResolvedValue({ sessions: { admitPrompt: plain } } as never)
    const submit = vi.fn().mockRejectedValue(phase === "before-submit"
      ? new ComputerPromptNotSubmittedError("handshake timeout") : new Error("admission unknown"))
    vi.spyOn(connection, "getComputerBridge").mockImplementation(async () => {
      if (phase === "stop") {
        // The interruption calls the same fake client after revoking local admission.
        void service.interruptSession({ sessionId: "session" }).catch(() => {})
        throw new Error("setup stopped")
      }
      return { submit } as never
    })
    const result = service.sendComputerPrompt({ id: 43 } as never, {
      id: "ordinary", sessionId: "session", items: [{ type: "text", text: "打开记事本" }], attachments: [],
    }, () => { if (phase === "hidden") throw new Error("hidden Desktop") }, new AbortController().signal, undefined, true)
    if (phase === "uncertain-submit" || phase === "stop") {
      await expect(result).rejects.toThrow(phase === "stop" ? /已停止/ : /admission unknown/)
      expect(plain).not.toHaveBeenCalled()
    } else {
      await result
      expect(plain).toHaveBeenCalledExactlyOnceWith("session", expect.objectContaining({ id: "ordinary" }), { signal: expect.any(AbortSignal) })
    }
    expect(submit).toHaveBeenCalledTimes(phase === "before-submit" || phase === "uncertain-submit" ? 1 : 0)
  }
)

it.each(["switch", "hide", "stop"] as const)("cancels a first paired Computer prompt when the user chooses to %s during reconnect", async action => {
  const h = await pairingPrompt()
  try {
    await h.reset
    const rejected = expect(h.request).rejects.toThrow(/会话|聊天|停止/)
    if (action === "stop") {
      await expect(h.service.interruptSession({ sessionId: "session" })).rejects.toThrow(/daemon offline/)
    } else if (action === "hide") {
      h.service.invalidateComputerView()
    } else {
      await h.service.subscriptions.openSession({ ...h.client, sessions: { getState: async () => ({
        ...h.snapshot, session: { ...h.snapshot.session, id: "other" },
      }) } }, h.owner, "other")
    }
    await rejected
    h.restore.resolve(h.snapshot)
    await h.openReplacement()
    expect(h.submit).not.toHaveBeenCalled()
  } finally {
    h.cleanup()
  }
})

it("uses the private reply only for a Computer approval delivered to the current primary session", async () => {
  const { service, connection } = serviceWithConnection()
  const reply = vi.spyOn(connection, "replyComputerApproval").mockResolvedValue()
  const authorize = vi.fn()
  const owner = { id: 43 } as never
  vi.spyOn(service.subscriptions, "getOwnerPermission").mockImplementation((ownerId, permissionId) =>
    ownerId === 43 && permissionId === "protected" ? {
      id: "protected", sessionId: "session", toolName: "Computer", status: "pending",
      payload: { computerApproval: true }, createdAt: 1, updatedAt: 1,
    } : undefined
  )
  const connect = vi.spyOn(service, "agentClient").mockRejectedValue(new Error("ordinary"))
  const approval = { permissionId: "protected", status: "approved" } as const
  await expect(service.replyPermission({ ...approval, decision: "session" }, owner, authorize)).rejects.toThrow(/仅接受本次/)
  await expect(service.replyPermission(approval, owner)).rejects.toThrow(/失效/)
  await service.replyPermission(approval, owner, authorize)
  expect(authorize).toHaveBeenCalledOnce()
  expect(reply).toHaveBeenCalledExactlyOnceWith("session", "protected", "approved")
  expect(connect).not.toHaveBeenCalled()
  await expect(service.replyPermission({ ...approval, permissionId: "ordinary" }, owner, authorize)).rejects.toThrow(/ordinary/)
  expect(reply).toHaveBeenCalledOnce()
})

it("chooses, lists and previews a real local directory with no daemon connection", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "vykor-offline-workspace-"))
  try {
    await writeFile(join(rootPath, "offline.txt"), "available offline")
    const { service } = serviceWithConnection()
    const transport = vi.spyOn(service, "daemonTransport").mockRejectedValue(new Error("daemon stopped"))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [rootPath] })

    const selected = await service.chooseProject({} as never)
    expect(selected).toMatchObject({ path: rootPath })
    await expect(service.readLocalProjectDirectory(rootPath)).resolves.toMatchObject({ path: rootPath })
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

it("recursively lists, previews and edits local project files while its session daemon is stopped", async () => {
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
    const session = await client.sessions.create({ projectId, cwd: sessionDirectory, model: "fixture" })
    await daemon.server.close()
    agentClient = vi.spyOn(desktopSessionService, "agentClient").mockRejectedValue(new Error("daemon stopped"))
    const listing = await workspaceService.listFiles({ rootPath: project })
    expect(listing.entries.map((entry) => entry.path)).toContain("task/nested/agent-only.txt")
    const file = { rootPath: project, path: join(session.cwd, "same.txt") }
    expect(await workspaceService.readFile(file)).toMatchObject({ scope: "project", content: "agent version" })
    expect(await workspaceService.writeFile({ ...file, originalContent: "agent version", content: "edited" }))
      .toMatchObject({ scope: "project", content: "edited" })
    expect(await workspaceService.readFile(file)).toMatchObject({ content: "edited" })
    expect(await workspaceService.readFile({ rootPath: project, path: "same.txt" })).toMatchObject({
      content: "project version",
    })
    expect(agentClient).not.toHaveBeenCalled()
  } finally {
    agentClient?.mockRestore()
    await daemon?.server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("creates a Desktop Git worktree session and reads the worktree locally", async () => {
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
    expect((await workspaceService.listFiles({ rootPath: session.cwd })).entries)
      .toContainEqual(expect.objectContaining({ path: "worktree-only.txt" }))
    expect(await workspaceService.readFile({ rootPath: session.cwd, path: "same.txt" }))
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

async function pairingPrompt(automatic?: true) {
  const { service, connection, invalidate } = serviceWithConnection()
  const owner = { id: 43, once: vi.fn(), isDestroyed: () => false, send: vi.fn() } as never
  const snapshot: SessionStateSnapshot = {
    cursor: 1, session: { id: "session", title: "记事本", cwd: "D:/repo", model: "fixture", status: "idle", createdAt: 1, updatedAt: 1, metadata: {} },
    inputs: [], messages: [], parts: [], runs: [], attempts: [], permissions: [], tasks: [],
  }
  const client = {
    sessions: { getState: async () => snapshot },
    events: { list: async () => [], stream: async function* () {} },
  }
  await service.subscriptions.openSession(client, owner, "session")
  const removeInvalidation = service.subscriptions.onOwnerInvalidated((_owner, change) => {
    if (!change?.daemonReset) service.invalidateComputerView(change?.nextSessionId)
  })
  const restore = Promise.withResolvers<SessionStateSnapshot>()
  const reset = Promise.withResolvers<void>()
  const submit = vi.fn(async (_id: string, _prompt: unknown, authorize: () => void) => { authorize() })
  const lifetime = new AbortController()
  vi.spyOn(service, "agentClient").mockRejectedValue(new Error("daemon offline"))
  vi.spyOn(connection, "getComputerBridge").mockImplementation(async (authorize, _signal, onControlledReset) => {
    onControlledReset?.()
    invalidate()
    authorize()
    reset.resolve()
    return { submit } as never
  })
  const request = service.sendComputerPrompt(owner, {
    id: "input", sessionId: "session", items: [{ type: "text", text: "打开记事本" }], attachments: [],
  }, () => {}, lifetime.signal, undefined, automatic)
  void request.catch(() => {})
  return {
    service, client, owner, snapshot, restore, reset: reset.promise, submit, request,
    openReplacement: () => service.subscriptions.openSession({ ...client, sessions: { getState: () => restore.promise } }, owner, "session"),
    cleanup() {
      lifetime.abort()
      removeInvalidation()
      service.subscriptions.clearAll()
    },
  }
}
