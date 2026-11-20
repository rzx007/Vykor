import { expect, it, vi } from "vitest"
import type { DesktopCommandCatalogEntry, DesktopProject } from "@shared/session-types"
import type { DesktopSkillInfo } from "@shared/skill-types"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { NEW_CONVERSATION_SCOPE } from "@renderer/stores/desktop-session/composer-draft-state"
import { prepareSkillConversation } from "../skill-quick-start"

const project: DesktopProject = {
  id: "client",
  name: "Client",
  path: "D:/Client",
  lastOpenedAt: 0,
  available: true,
}
const skill: DesktopSkillInfo = {
  id: "release-project",
  name: "release",
  path: "D:/Client/.vykor/skills/release/SKILL.md",
  description: "Release",
  content: "# Release",
  source: "project",
  readOnly: false,
  projectPath: project.path,
}

function trialState() {
  return {
    projects: [project],
    selectedProject: null,
    selectProject: vi.fn(async () => {}),
    startNewConversation: vi.fn(async () => {}),
    setGoalMode: vi.fn(),
    setComposerDraftDocument: vi.fn(),
    composerDraftsByScope: {
      [NEW_CONVERSATION_SCOPE]: {
        document: composerDocument([{ type: "text", text: "未完成的草稿" }]),
        attachments: [],
      },
    },
  }
}

it("inserts the chosen copy into a new conversation in its project and preserves the draft", async () => {
  const state = trialState()
  const command: DesktopCommandCatalogEntry = {
    kind: "template",
    name: "release",
    skillName: "release",
    path: skill.path,
  }
  const listCommands = vi.fn(async () => [command])

  await prepareSkillConversation(skill, () => state, listCommands)

  expect(listCommands).toHaveBeenCalledWith(project.path)
  expect(state.selectProject).toHaveBeenCalledWith(project)
  expect(state.startNewConversation).toHaveBeenCalledOnce()
  expect(state.setComposerDraftDocument).toHaveBeenCalledWith(
    NEW_CONVERSATION_SCOPE,
    composerDocument([
      { type: "skill", name: "release", path: skill.path },
      { type: "text", text: " 未完成的草稿" },
    ])
  )
})

it("keeps the current draft when the command catalog exposes a different copy", async () => {
  const state = trialState()
  const alternative: DesktopCommandCatalogEntry = {
    kind: "template",
    name: "release",
    skillName: "release",
    path: "D:/personal/skills/release/SKILL.md",
  }
  await expect(
    prepareSkillConversation(
      skill,
      () => state,
      async () => [alternative]
    )
  ).rejects.toThrow(/无法调用这份技能/)
  expect(state.selectProject).not.toHaveBeenCalled()
  expect(state.startNewConversation).not.toHaveBeenCalled()
  expect(state.setComposerDraftDocument).not.toHaveBeenCalled()
})
