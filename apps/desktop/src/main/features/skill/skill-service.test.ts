import { beforeEach, describe, expect, it, vi } from "vitest"

const daemon = vi.hoisted(() => ({
  development: {
    listSkills: vi.fn(),
    removeSkill: vi.fn(),
  },
}))

const refreshedDaemon = vi.hoisted(() => ({
  development: {
    listSkills: vi.fn(),
    removeSkill: vi.fn(),
  },
}))

const sessionService = vi.hoisted(() => ({
  daemonClient: vi.fn(async () => daemon),
  refreshDaemonClient: vi.fn(async () => refreshedDaemon),
}))

vi.mock("../session/session-service", () => ({
  desktopSessionService: sessionService,
}))

import { DesktopSkillService } from "./skill-service"

const snapshot = {
  skills: [],
  projects: [{ name: "OpenHarness", path: "D:/code/OpenHarness-ts" }],
  warnings: [],
}

const mixedSnapshot = {
  warnings: [],
  projects: [
    { name: "OpenHarness", path: "D:/code/OpenHarness-ts" },
    { name: "Other", path: "D:/code/other" },
    { name: "x10", path: "D:/Documents/OpenHarness/2026-09-09/x10" },
  ],
  skills: [
    {
      id: "builtin",
      name: "builtin",
      description: "built in",
      content: "builtin",
      path: "",
      source: "bundled",
      readOnly: true,
    },
    {
      id: "current-project",
      name: "current-project",
      description: "current project",
      content: "project",
      path: "D:/code/OpenHarness-ts/.openharness-ts/skills/current/SKILL.md",
      source: "project",
      readOnly: false,
      projectPath: "D:/code/OpenHarness-ts",
      projectName: "OpenHarness",
    },
    {
      id: "current-agent",
      name: "current-agent",
      description: "current agent",
      content: "agent",
      path: "D:/code/OpenHarness-ts/.agents/skills/current/SKILL.md",
      source: "agent",
      readOnly: true,
      projectPath: "D:/code/OpenHarness-ts",
      projectName: "OpenHarness",
    },
    {
      id: "other-project",
      name: "other-project",
      description: "other project",
      content: "other",
      path: "D:/code/other/.openharness-ts/skills/other/SKILL.md",
      source: "project",
      readOnly: false,
      projectPath: "D:/code/other",
      projectName: "Other",
    },
    {
      id: "standard",
      name: "standard",
      description: "standard",
      content: "standard",
      path: "C:/Users/ruanz/.agents/skills/standard/SKILL.md",
      source: "standard",
      readOnly: true,
    },
    {
      id: "personal",
      name: "personal",
      description: "personal",
      content: "personal",
      path: "C:/Users/ruanz/.openharness-ts/skills/personal/SKILL.md",
      source: "personal",
      readOnly: false,
    },
    {
      id: "outside-project",
      name: "outside-project",
      description: "outside project workspace",
      content: "outside",
      path: "D:/Documents/OpenHarness/2026-09-09/x10/.openharness-ts/skills/outside/SKILL.md",
      source: "project",
      readOnly: false,
      projectPath: "D:/Documents/OpenHarness/2026-09-09/x10",
      projectName: "x10",
    },
  ],
} as const

describe("DesktopSkillService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    daemon.development.listSkills.mockResolvedValue(snapshot)
    daemon.development.removeSkill.mockResolvedValue(snapshot)
    refreshedDaemon.development.listSkills.mockResolvedValue(snapshot)
    refreshedDaemon.development.removeSkill.mockResolvedValue(snapshot)
  })

  it("delegates snapshots to the daemon client and hides outside-project workspaces", async () => {
    daemon.development.listSkills.mockResolvedValueOnce(mixedSnapshot)
    const service = new DesktopSkillService({ documentsPath: "D:/Documents" })

    await expect(service.snapshot({ projectPath: "D:/code/OpenHarness-ts" })).resolves.toEqual({
      warnings: [],
      projects: [
        { name: "OpenHarness", path: "D:/code/OpenHarness-ts" },
        { name: "Other", path: "D:/code/other" },
      ],
      skills: [
        mixedSnapshot.skills[0],
        mixedSnapshot.skills[1],
        mixedSnapshot.skills[2],
        mixedSnapshot.skills[3],
        mixedSnapshot.skills[4],
        mixedSnapshot.skills[5],
      ],
    })
    expect(daemon.development.listSkills).toHaveBeenCalledOnce()
    expect(daemon.development.listSkills).toHaveBeenCalledWith()
    expect(sessionService.refreshDaemonClient).not.toHaveBeenCalled()
  })

  it("does not require the current page project to be in the skill catalog", async () => {
    daemon.development.listSkills.mockResolvedValueOnce(mixedSnapshot)
    const service = new DesktopSkillService({ documentsPath: "D:/Documents" })

    await expect(service.snapshot({ projectPath: "D:/code/hidden" })).resolves.toMatchObject({
      projects: [
        { name: "OpenHarness", path: "D:/code/OpenHarness-ts" },
        { name: "Other", path: "D:/code/other" },
      ],
    })
  })

  it("delegates removal and returns the daemon response", async () => {
    const service = new DesktopSkillService({ documentsPath: "D:/Documents" })
    const input = {
      id: "skill_personal",
      expectedContent: "current skill contents",
      projectPath: "D:/code/OpenHarness-ts",
    }

    await expect(service.remove(input)).resolves.toEqual(snapshot)
    expect(daemon.development.removeSkill).toHaveBeenCalledWith("skill_personal", {
      expectedContent: "current skill contents",
    })
    expect(daemon.development.listSkills).not.toHaveBeenCalled()
  })

  it.each(["Failed to fetch", "connect ECONNREFUSED", "read ECONNRESET"])(
    "refreshes the daemon client and retries once after %s",
    async (message) => {
      daemon.development.listSkills.mockRejectedValueOnce(new Error(message))
      const service = new DesktopSkillService({ documentsPath: "D:/Documents" })

      await expect(service.snapshot({ projectPath: "D:/code/OpenHarness-ts" })).resolves.toEqual(
        snapshot
      )
      expect(daemon.development.listSkills).toHaveBeenCalledOnce()
      expect(sessionService.refreshDaemonClient).toHaveBeenCalledOnce()
      expect(refreshedDaemon.development.listSkills).toHaveBeenCalledOnce()
    }
  )

  it("does not retry non-connection errors", async () => {
    const error = new Error("skill conflict")
    daemon.development.removeSkill.mockRejectedValueOnce(error)
    const service = new DesktopSkillService({ documentsPath: "D:/Documents" })

    await expect(
      service.remove({
        id: "skill_personal",
        expectedContent: "stale contents",
        projectPath: "D:/code/OpenHarness-ts",
      })
    ).rejects.toBe(error)
    expect(sessionService.refreshDaemonClient).not.toHaveBeenCalled()
    expect(refreshedDaemon.development.removeSkill).not.toHaveBeenCalled()
  })
})
