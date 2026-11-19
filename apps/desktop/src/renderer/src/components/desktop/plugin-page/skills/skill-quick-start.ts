import type { DesktopCommandCatalogEntry } from "@shared/session-types"
import type { DesktopSkillInfo } from "@shared/skill-types"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import {
  NEW_CONVERSATION_SCOPE,
  selectDraftDocument,
} from "@renderer/stores/desktop-session/composer-draft-state"
import type { DesktopSessionState } from "@renderer/stores/desktop-session/types"

type SkillTrialState = Pick<
  DesktopSessionState,
  | "projects"
  | "selectedProject"
  | "selectProject"
  | "startNewConversation"
  | "setGoalMode"
  | "setComposerDraftDocument"
  | "composerDraftsByScope"
>

export async function prepareSkillConversation(
  skill: DesktopSkillInfo,
  getState: () => SkillTrialState,
  listCommands: (cwd: string) => Promise<DesktopCommandCatalogEntry[]>
): Promise<void> {
  const state = getState()
  const targetPath = skill.projectPath
  const project = targetPath
    ? state.projects.find((item) => pathKey(item.path) === pathKey(targetPath))
    : state.selectedProject
  if (targetPath && !project?.available) throw new Error("这个技能所属的项目暂不可用。")

  const catalog = await listCommands(project?.path ?? ".")
  const command = catalog.find(
    (item) =>
      item.kind === "template" &&
      item.skillName === skill.name &&
      item.path &&
      pathKey(item.path) === pathKey(skill.path)
  )
  if (command?.kind !== "template") throw new Error("所选范围当前无法调用这份技能。")

  if (project && project.id !== getState().selectedProject?.id)
    await getState().selectProject(project)
  await getState().startNewConversation()
  getState().setGoalMode(NEW_CONVERSATION_SCOPE, false)
  const next = getState()
  const draft = selectDraftDocument(next, NEW_CONVERSATION_SCOPE)
  const items = draft.items.filter(
    (item) => item.type !== "skill" || pathKey(item.path) !== pathKey(command.path)
  )
  next.setComposerDraftDocument(
    NEW_CONVERSATION_SCOPE,
    composerDocument([
      {
        type: "skill",
        name: command.skillName,
        path: command.path,
        displayName: command.displayName,
      },
      { type: "text", text: " " },
      ...items,
    ])
  )
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
