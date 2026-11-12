import type { VykorClient } from "@vykor/application-client"
import type {
  DesktopSkillRemoveInput,
  DesktopSkillSnapshot,
  DesktopSkillSnapshotInput,
} from "../../../shared/skill-types"
import { getDataRoot, isHiddenManagedProjectPath } from "@vykor/host-config/paths"
import { desktopSessionService } from "../session/session-service"

type SkillClient = Pick<VykorClient, "runtime" | "development">

export interface DesktopSkillServiceOptions {
  dataRoot?: string
}

export class DesktopSkillService {
  constructor(private readonly options: DesktopSkillServiceOptions = {}) {}

  async snapshot(input: DesktopSkillSnapshotInput): Promise<DesktopSkillSnapshot> {
    void input
    return filterOutsideProjectWorkspaces(
      await withDaemonRetry((client) => client.runtime.listSkills()),
      this.dataRoot()
    )
  }

  async remove(input: DesktopSkillRemoveInput): Promise<DesktopSkillSnapshot> {
    return filterOutsideProjectWorkspaces(
      await withDaemonRetry((client) =>
        client.development.removeSkill(input.id, { expectedContent: input.expectedContent })
      ),
      this.dataRoot()
    )
  }

  private dataRoot(): string {
    return this.options.dataRoot ?? getDataRoot()
  }
}

export const desktopSkillService = new DesktopSkillService()

async function withDaemonRetry<T>(
  operation: (client: SkillClient) => Promise<T>
): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}

function filterOutsideProjectWorkspaces(
  snapshot: DesktopSkillSnapshot,
  dataRoot: string
): DesktopSkillSnapshot {
  const projects = snapshot.projects.filter(
    (project) => !isHiddenManagedProjectPath(project.path, dataRoot)
  )
  const projectKeys = new Set(projects.map((project) => pathKey(project.path)))

  return {
    warnings: snapshot.warnings,
    projects,
    skills: snapshot.skills.filter((skill) => {
      if (
        skill.source === "bundled" ||
        skill.source === "standard" ||
        skill.source === "personal"
      )
        return true
      if (!skill.projectPath) return false
      return projectKeys.has(pathKey(skill.projectPath))
    }),
  }
}

function pathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}
