import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { createDesktopGitWorktree } from "@vykor/server"
import { ChannelRuntimeService } from "../../../../../../../packages/server/src/daemon/channel-runtime-service"
import { ScheduledTaskExecutor } from "../../../../../../../packages/server/src/application/schedule/scheduled-task-executor"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join, relative, win32, posix } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { CURRENT_PROTOCOL_VERSION } from "@vykor/application-client"
import { getDataRoot } from "@vykor/host-config/paths"

vi.mock("electron", () => ({
  app: { getPath: () => join(process.env.VYKOR_CONFIG_DIR!, "old-documents") },
}))
import { DesktopSessionService } from "../session-service"
import { DaemonConnectionService } from "../daemon-connection-service"
import { SessionOperations } from "../session-operations"
import { toDesktopSessionRecord } from "../session-subscription-service"
import { classifyWorkspacePath } from "../../workspace/workspace-path"
import { workspaceService } from "../../workspace/workspace-service"

function client(create: (input: any) => Promise<any>) {
  return {
    system: { getSettings: async () => ({}) },
    runtime: { listModels: async () => [{ models: [{ id: "model", providerName: "local" }] }] },
    sessions: { create },
  }
}
const record = async (input: any) => ({
  ...input,
  id: input.cwd,
  title: "",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
})

async function writeMapFixture() {
  const root = getDataRoot()
  const legacy = join(root, "legacy-documents", "Vykor")
  const excluded = join(root, "retained-migration")
  await mkdir(join(root, "data", "migrations"), { recursive: true })
  await writeFile(
    join(root, "data", "migrations", "path-map.json"),
    JSON.stringify({
      version: 1,
      moves: [
        { kind: "workspace", from: legacy, to: join(root, "workspaces") },
        { kind: "user-root", from: join(root, "old-user"), to: root },
      ],
      excludedRoots: [excluded],
    })
  )
  return { root, legacy, excluded }
}

describe("managed workspace data root", () => {
  it("creates two independent projectless chats and leaves an external project's cwd intact", async () => {
    const api = client(record)
    const operations = new SessionOperations()
    const chats = await Promise.all(
      [1, 2].map(() =>
        operations.createSession(api as never, { model: "model", provider: "local" })
      )
    )
    expect(chats[0]!.cwd).not.toBe(chats[1]!.cwd)
    for (const chat of chats) {
      expect(relative(getDataRoot(), chat.cwd).replace(/\\/g, "/")).toMatch(
        /^workspaces\/\d{4}-\d{2}-\d{2}\/x\d+$/
      )
      expect(chat.workspaceMode).toBe("outside_project")
      expect(existsSync(chat.cwd)).toBe(true)
    }
    const projectCwd = join(getDataRoot(), "external-project-fixture")
    const project = await operations.createSession(api as never, {
      model: "model",
      provider: "local",
      projectId: "p",
      cwd: projectCwd,
      taskLocation: "current",
    })
    expect(project.cwd).toBe(projectCwd)
    expect(project.workspaceMode).toBe("project")
  })

  it("removes only this attempt's empty workspace after session creation fails", async () => {
    const roots: string[] = []
    for (const content of [false, true]) {
      await expect(
        new SessionOperations().createSession(
          client(async (input) => {
            roots.push(input.cwd)
            if (content) await writeFile(join(input.cwd, "keep.txt"), "user output")
            throw new Error("create failed")
          }) as never,
          { model: "model", provider: "local" }
        )
      ).rejects.toThrow("create failed")
      expect(existsSync(roots.at(-1)!)).toBe(content)
    }
    expect(await readdir(roots[1]!)).toEqual(["keep.txt"])
  })

  it("classifies canonical and explicitly mapped workspaces without granting the entire old root", async () => {
    const { root, legacy, excluded } = await writeMapFixture()
    for (const cwd of [
      join(root, "workspaces", "2026-11-12", "x1"),
      join(root, "channels", "feishu", "chat"),
      join(legacy, "2026-11-12", "x1"),
    ]) {
      expect(toDesktopSessionRecord({ cwd, metadata: {} } as any).workspaceMode).toBe(
        "outside_project"
      )
      const classification = classifyWorkspacePath(
        cwd,
        workspaceService.allowedRootsFor(join(root, "project")),
        { win32, posix }
      )
      if (!cwd.startsWith(legacy)) expect(classification?.rootLabel).toBe("项目外工作区")
      else expect(classification).toBeNull()
    }
    expect(
      classifyWorkspacePath(
        join(root, "old-user", "credentials.json"),
        workspaceService.allowedRootsFor(join(root, "project")),
        { win32, posix }
      )
    ).toBeNull()
    expect(
      classifyWorkspacePath(
        join(excluded, "file.txt"),
        workspaceService.allowedRootsFor(join(root, "project")),
        { win32, posix }
      )
    ).toBeNull()
    expect(
      toDesktopSessionRecord({ cwd: join(root, "Documents", "Vykor", "x1"), metadata: {} } as any)
        .workspaceMode
    ).toBe("project")
  })

  it("returns the canonical root in bootstrap and hides mapped, channel, and retained projects", async () => {
    const { root } = await writeMapFixture()
    const projectPaths = [
      join(root, "workspaces", "x1"),
      join(root, "channels", "chat"),
      join(root, "legacy-documents", "Vykor", "x1"),
      join(root, "retained-migration", "stage"),
      join(root, "Documents", "Vykor", "unmapped"),
      join(root, "external-project"),
    ]
    const api = {
      system: { getSettings: async () => ({}) },
      runtime: { listModels: async () => [] },
      sessions: { list: async () => [] },
      projects: { list: async () => projectPaths.map((path, id) => ({ id: String(id), path })) },
      protocol: {
        capabilities: async () => ({
          serverVersion: "current",
          protocol: { version: CURRENT_PROTOCOL_VERSION },
          features: { pluginCapabilities: 1 },
        }),
      },
    }
    const connection = new DaemonConnectionService()
    vi.spyOn(connection, "getClient").mockResolvedValue(api as never)
    const result = await new DesktopSessionService(connection).bootstrap()
    expect(result.outsideProjectWorkspaceRoot).toBe(join(root, "workspaces"))
    expect(result.projects.map((project) => project.path)).toEqual(projectPaths.slice(4))
  })

  it("keeps five managed execution directories in one root and the real project in place", async () => {
    const root = getDataRoot()
    const projectPath = await mkdtemp(join(tmpdir(), "vykor-t4-real-project-"))
    const command = promisify(execFile)
    const git = (args: string[], cwd = projectPath) =>
      command("git", args, { cwd, windowsHide: true })
    let channelInput: any
    const channels = new ChannelRuntimeService({
      application: {} as any,
      config: {
        getFeishu: async () => ({
          enabled: true,
          appId: "fixture",
          appSecret: "fixture",
          domain: "feishu",
          allowFrom: { tester: "sender" },
        }),
      },
      getSettings: () => ({ model: "model" }) as any,
      verify: async () => ({ name: "fixture" }),
      createRuntime: async (input) => {
        channelInput = input
        return {
          start: async () => {},
          stopInbound: async () => {},
          stopBridge: async () => {},
          stop: async () => {},
        }
      },
    })
    try {
      await git(["init", "-b", "main"])
      await git(["config", "user.name", "Fixture"])
      await git(["config", "user.email", "fixture@example.invalid"])
      await writeFile(join(projectPath, "file.txt"), "project stays here")
      await git(["add", "."])
      await git(["commit", "-m", "fixture"])
      const api = client(record)
      const operations = new SessionOperations()
      const chats = await Promise.all(
        [1, 2].map(() =>
          operations.createSession(api as never, { model: "model", provider: "local" })
        )
      )
      await channels.startEnabled()
      const channelCwd = await channelInput.resolveCwd({
        channel: "feishu",
        accountId: "fixture",
        chatId: "chat",
        senderId: "sender",
        metadata: {},
      })
      const channelChat = await api.sessions.create({ cwd: channelCwd })
      let scheduledCwd = ""
      const executor = new ScheduledTaskExecutor({
        settings: { model: "model" } as any,
        sessionQueries: { getSession: () => undefined },
        sessionCommands: {
          createSession: (input: any) => {
            scheduledCwd = input.cwd
            return { id: "scheduled-fixture", ...input }
          },
        } as any,
        sessionInteractions: { admitPrompt: async () => ({ run: { id: "run" } }) as any },
        runControl: { awaitRun: async () => ({ status: "completed", output: "done" }) as any },
      })
      await executor.execute(
        {
          id: "task-fixture",
          name: "Fixture",
          prompt: "work",
          destination: "standalone",
          executionMode: "direct",
          projectPaths: [],
          skillNames: [],
          pluginNames: [],
          permissionProfile: { mode: "workspace_write" },
        } as any,
        { id: "acceptance-fixture", scheduledFor: 1 } as any,
        () => {}
      )
      const tree = await createDesktopGitWorktree({
        cwd: projectPath,
        configDir: root,
        slug: "acceptance-fixture",
        branch: "fixture/managed-task",
        runGit: async (args, cwd) => {
          try {
            return { code: 0, stdout: (await git(args, cwd)).stdout, stderr: "" }
          } catch (error: any) {
            return { code: 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }
          }
        },
      })
      const paths = [...chats.map((chat) => chat.cwd), channelChat.cwd, scheduledCwd, tree.path]
      expect(new Set(paths).size).toBe(5)
      expect(paths.map((path) => relative(root, path).replace(/\\/g, "/"))).toEqual([
        expect.stringMatching(/^workspaces\/\d{4}-\d{2}-\d{2}\/x\d+$/),
        expect.stringMatching(/^workspaces\/\d{4}-\d{2}-\d{2}\/x\d+$/),
        expect.stringMatching(/^channels\/feishu\//),
        expect.stringMatching(/^workspaces\/\d{4}-\d{2}-\d{2}\/scheduled-acceptance-fixture$/),
        expect.stringMatching(/^worktrees\/[^/]+\/acceptance-fixture$/),
      ])
      const directProjectChat = await operations.createSession(api as never, {
        model: "model",
        provider: "local",
        projectId: "real-project",
        cwd: projectPath,
        taskLocation: "current",
      })
      expect(directProjectChat.cwd).toBe(projectPath)
      expect((await git(["status", "--porcelain"])).stdout).toBe("")
      expect(paths.every((path) => existsSync(path))).toBe(true)
    } finally {
      await channels.shutdown()
      await rm(projectPath, { recursive: true, force: true })
    }
  })
})
