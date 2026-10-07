import { beforeEach, describe, expect, it, vi } from "vitest"
const git = vi.hoisted(() => ({ createTaskWorktree: vi.fn(), bindTaskWorktree: vi.fn(), discardUnboundWorktree: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "C:\\Documents" } }))
vi.mock("../settings/git-settings-service", () => ({ gitSettingsService: git }))
vi.mock("../settings/git-settings-storage", () => ({ getGitPreferences: () => ({ defaultTaskLocation: "current" }) }))
import { SessionOperations } from "./session-operations"

const base = { projectId: "project", cwd: "D:\\owner", model: "model", provider: "provider", taskLocation: "worktree" as const }
function client() {
  return { system: { getSettings: vi.fn(async () => ({})) },
    providers: { listModels: vi.fn(async () => [{ name: "provider", models: [{ id: "model", providerName: "provider" }] }]) },
    sessions: { create: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: "session", title: "", status: "idle", createdAt: 1, updatedAt: 1 })), archive: vi.fn(async () => ({})) } }
}
beforeEach(() => { vi.resetAllMocks(); git.createTaskWorktree.mockResolvedValue({ id: "tree", path: "D:\\tasks\\tree", branch: "task/tree" }) })
describe("task worktree creation", () => {
  it("creates, binds and keeps the original project settings root", async () => {
    const api = client()
    const result = await new SessionOperations().createSession(api as never, base)
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "D:\\tasks\\tree", metadata: expect.objectContaining({ desktop: { settingsRoot: base.cwd, worktree: { id: "tree", path: "D:\\tasks\\tree", branch: "task/tree" } } }) }))
    expect(result.cwd).toBe("D:\\tasks\\tree")
    expect(git.bindTaskWorktree).toHaveBeenCalledWith("tree", "session")
  })
  it("archives a failed binding before cleaning an unbound directory", async () => {
    const api = client()
    git.bindTaskWorktree.mockRejectedValue(new Error("binding failed"))
    await expect(new SessionOperations().createSession(api as never, base)).rejects.toThrow("binding failed")
    expect(api.sessions.archive).toHaveBeenCalledWith("session")
    expect(git.discardUnboundWorktree).toHaveBeenCalledWith("tree")
    expect(api.sessions.archive.mock.invocationCallOrder[0]).toBeLessThan(git.discardUnboundWorktree.mock.invocationCallOrder[0]!)
  })
  it("never falls back to editing the original directory after creation fails", async () => {
    const api = client()
    git.createTaskWorktree.mockRejectedValue(new Error("Git unavailable"))
    await expect(new SessionOperations().createSession(api as never, base)).rejects.toThrow("Git unavailable")
    expect(api.sessions.create).not.toHaveBeenCalled()
  })
  it("preserves a possibly live directory when compensating archive fails", async () => {
    const api = client()
    git.bindTaskWorktree.mockRejectedValue(new Error("binding failed"))
    api.sessions.archive.mockRejectedValue(new Error("archive failed"))
    await expect(new SessionOperations().createSession(api as never, base)).rejects.toThrow("archive failed")
    expect(git.discardUnboundWorktree).not.toHaveBeenCalled()
  })
  it("rejects a disabled model before allocating a worktree", async () => {
    const api = client()
    api.system.getSettings.mockResolvedValue({ modelDisabled: true })
    await expect(new SessionOperations().createSession(api as never, base)).rejects.toThrow(/默认模型已停用/)
    expect(git.createTaskWorktree).not.toHaveBeenCalled()
  })
})
