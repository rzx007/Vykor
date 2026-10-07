import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
const host = vi.hoisted(() => ({
  userData: "",
  projectPath: "",
  state: {
    session: { status: "archived", metadata: {} as Record<string, unknown> },
    runs: [],
    tasks: [],
  },
  bindingFailure: false,
  bindingRequests: [] as Array<{
    sessionId: string
    binding: { id: string; path: string; branch: string }
  }>,
}))
vi.mock("electron", () => ({
  app: { getPath: () => host.userData },
  dialog: { showOpenDialog: vi.fn() },
}))
vi.mock("../session/session-service", () => ({
  desktopSessionService: {
    daemonClient: async () => ({
      projects: { list: async () => [{ id: "project", name: "Project", path: host.projectPath }] },
      protocol: { capabilities: async () => ({ features: { gitWorktreeBindings: 1 } }) },
      sessions: {
        list: async () => [{ id: "session", title: "Task" }],
        getState: async () => host.state,
        clearWorktreeBinding: async (
          sessionId: string,
          binding: { id: string; path: string; branch: string }
        ) => {
          host.bindingRequests.push({ sessionId, binding })
          if (host.bindingFailure) throw new Error("Binding update unavailable")
          const desktop = host.state.session.metadata.desktop as Record<string, unknown> | undefined
          if (desktop) {
            const { worktree: _worktree, ...rest } = desktop
            host.state.session.metadata = { ...host.state.session.metadata, desktop: rest }
          }
          return host.state.session
        },
      },
    }),
  },
}))
vi.mock("./runtime-settings-service", () => ({
  desktopRuntimeSettingsService: {
    snapshot: async () => ({ effective: { kind: "native" }, source: "用户默认" }),
  },
}))
vi.mock("@vykor/server", async () => ({
  createDesktopGitWorktree: (
    await import("../../../../../../packages/server/src/desktop-git-workspaces")
  ).createDesktopGitWorktree,
}))
import { GitSettingsService, worktreeCleanupAllowed } from "./git-settings-service"
import { defaultGitPreferences } from "../../../shared/git-settings-types"
import { readGitSettingsAt, writeGitSettingsAt } from "./git-settings-storage"
const command = promisify(execFile)
const service = new GitSettingsService()
let base: string
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "vykor-git-settings-"))
  host.userData = join(base, "settings")
  host.projectPath = join(base, "project")
  await mkdir(host.projectPath)
  await mkdir(host.userData)
  await command("git", ["init", "-b", "main"], { cwd: host.projectPath })
  await command("git", ["config", "user.name", "Initial"], { cwd: host.projectPath })
  await command("git", ["config", "user.email", "initial@example.com"], { cwd: host.projectPath })
  await writeFile(join(host.projectPath, "file.txt"), "initial\n")
  await command("git", ["add", "."], { cwd: host.projectPath })
  await command("git", ["commit", "-m", "initial"], { cwd: host.projectPath })
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})
describe("Git settings", () => {
  it("persists a versioned preference file and rejects stale saves", async () => {
    const initial = readGitSettingsAt(host.userData)
    expect(initial.preferences).toEqual(defaultGitPreferences)
    const preferences = { ...initial.preferences, branchPrefix: "test/", ignoreWhitespace: true }
    await service.updatePreferences({ preferences, expected: initial.preferences })
    expect(readGitSettingsAt(host.userData).preferences).toEqual(preferences)
    await expect(
      service.updatePreferences({ preferences: initial.preferences, expected: initial.preferences })
    ).rejects.toThrow("已被修改")
  })
  it("saves only the selected repository identity and rejects stale input", async () => {
    const input = {
      scope: "project" as const,
      projectId: "project",
      environment: "native" as const,
      name: "New Name",
      email: "new@example.com",
      expectedName: "Initial",
      expectedEmail: "initial@example.com",
    }
    const value = await service.updateIdentity(input)
    expect(value.projectIdentity?.configuredName).toBe("New Name")
    expect(
      (
        await command("git", ["config", "--local", "user.email"], { cwd: host.projectPath })
      ).stdout.trim()
    ).toBe("new@example.com")
    await expect(service.updateIdentity(input)).rejects.toThrow("已被修改")
  })
  it("creates a prefixed branch without overwriting a conflicting branch", async () => {
    await command("git", ["branch", "test/task"], { cwd: host.projectPath })
    expect(await service.uniqueBranch(host.projectPath, "task")).toBe("test/task-2")
  })
  it("saves the global identity atomically without changing the project identity or other config", async () => {
    const previous = process.env.GIT_CONFIG_GLOBAL
    const globalPath = join(base, "global.gitconfig")
    process.env.GIT_CONFIG_GLOBAL = globalPath
    try {
      await writeFile(
        globalPath,
        "[core]\n\tautocrlf = false\n[user]\n\tname = Global Name\n\temail = global@example.com\n"
      )
      const result = await service.updateIdentity({
        scope: "global",
        environment: "native",
        name: "Updated Global",
        email: "updated@example.com",
        expectedName: "Global Name",
        expectedEmail: "global@example.com",
      })
      expect(result.globalIdentity?.configuredName).toBe("Updated Global")
      expect(
        (
          await command("git", ["config", "--global", "core.autocrlf"], { cwd: host.projectPath })
        ).stdout.trim()
      ).toBe("false")
      expect(
        (
          await command("git", ["config", "--local", "user.name"], { cwd: host.projectPath })
        ).stdout.trim()
      ).toBe("New Name")
      await writeFile(`${globalPath}.lock`, "held by another Git writer")
      await expect(
        service.updateIdentity({
          scope: "global",
          environment: "native",
          name: "Must not save",
          email: "mustnot@example.com",
          expectedName: "Updated Global",
          expectedEmail: "updated@example.com",
        })
      ).rejects.toThrow("其他程序修改")
      expect(
        (
          await command("git", ["config", "--global", "user.name"], { cwd: host.projectPath })
        ).stdout.trim()
      ).toBe("Updated Global")
      expect(
        (
          await command("git", ["config", "--global", "user.email"], { cwd: host.projectPath })
        ).stdout.trim()
      ).toBe("updated@example.com")
      await rm(`${globalPath}.lock`)
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })
  it("protects dirty worktrees, unmerged commits and active sessions", async () => {
    const record = await service.createTaskWorktree("project", host.projectPath)
    expect(record.branch).toMatch(/^test\/task-/)
    service.bindTaskWorktree(record.id, "session")
    await writeFile(join(record.path, "file.txt"), "changed\n")
    expect((await service.worktrees())[0]?.cleanupAllowed).toBe(false)
    await expect(service.cleanup({ id: record.id })).rejects.toThrow("未提交")
    await command("git", ["add", "."], { cwd: record.path })
    await command("git", ["commit", "-m", "worktree result"], { cwd: record.path })
    expect((await service.worktrees())[0]?.cleanupAllowed).toBe(false)
    await expect(service.cleanup({ id: record.id })).rejects.toThrow("成果")
    host.state.session.status = "running"
    await expect(service.markDisposable({ id: record.id, disposable: true })).rejects.toThrow(
      "已结束"
    )
    host.state.session.status = "archived"
    await service.markDisposable({ id: record.id, disposable: true })
    await service.cleanup({ id: record.id })
    expect(await service.worktrees()).toEqual([])
    expect(
      (await command("git", ["show-ref", `refs/heads/${record.branch}`], { cwd: host.projectPath }))
        .stdout
    ).toBeTruthy()
  })
  it("never permits unknown state or foreign worktrees", () => {
    const safe = { active: false, dirty: false, preserved: true, disposable: false, verified: true }
    expect(worktreeCleanupAllowed(safe)).toBe(true)
    expect(worktreeCleanupAllowed({ ...safe, dirty: null })).toBe(false)
    expect(worktreeCleanupAllowed({ ...safe, verified: false })).toBe(false)
  })
  it("clears an archived session binding after removing its directory while preserving other metadata", async () => {
    const record = await service.createTaskWorktree("project", host.projectPath)
    service.bindTaskWorktree(record.id, "session")
    host.state.session.metadata = {
      desktop: {
        worktree: { id: record.id, path: record.path, branch: record.branch },
        settingsRoot: host.projectPath,
        retained: true,
      },
      runtime: { model: "retained-model" },
    }
    await service.cleanup({ id: record.id })
    expect(host.state.session.metadata).toEqual({
      desktop: { settingsRoot: host.projectPath, retained: true },
      runtime: { model: "retained-model" },
    })
    expect(host.bindingRequests.at(-1)).toEqual({
      sessionId: "session",
      binding: { id: record.id, path: record.path, branch: record.branch },
    })
    expect(readGitSettingsAt(host.userData).worktrees).toEqual([])
  })
  it("reports removed directories separately and retries failed binding updates without deleting again", async () => {
    const record = await service.createTaskWorktree("project", host.projectPath)
    service.bindTaskWorktree(record.id, "session")
    host.state.session.metadata = {
      desktop: {
        worktree: { id: record.id, path: record.path, branch: record.branch },
        settingsRoot: host.projectPath,
      },
    }
    host.bindingFailure = true
    try {
      await expect(service.cleanup({ id: record.id })).rejects.toThrow("目录已清理")
      expect(readGitSettingsAt(host.userData).worktrees).toHaveLength(1)
      const pending = (await service.worktrees())[0]!
      expect(pending.cleanupAllowed).toBe(true)
      expect(pending.reason).toContain("绑定")
    } finally {
      host.bindingFailure = false
    }
    await new GitSettingsService().cleanup({ id: record.id })
    expect(readGitSettingsAt(host.userData).worktrees).toEqual([])
    expect(host.state.session.metadata).toEqual({ desktop: { settingsRoot: host.projectPath } })
    expect(
      (await command("git", ["show-ref", `refs/heads/${record.branch}`], { cwd: host.projectPath }))
        .stdout
    ).toBeTruthy()
  })
  it("rejects malformed saved formats instead of guessing a migration", () => {
    writeGitSettingsAt(host.userData, {
      version: 1,
      preferences: { ...defaultGitPreferences, branchPrefix: "../bad" },
      worktrees: [],
    })
    expect(() => readGitSettingsAt(host.userData)).toThrow("格式无效")
  })
})
