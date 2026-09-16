import type { OpenHarnessClient } from "@openharness/client"
import type {
  DesktopSkillRemoveInput,
  DesktopSkillSnapshot,
  DesktopSkillSnapshotInput,
} from "../../../shared/skill-types"
import { app } from "electron"
import { isOutsideProjectWorkspacePath } from "../session/outside-project-workspace"
import { desktopSessionService } from "../session/session-service"

type SkillClient = Pick<OpenHarnessClient, "development">

export interface DesktopSkillServiceOptions {
  documentsPath?: string
}

export class DesktopSkillService {
  constructor(private readonly options: DesktopSkillServiceOptions = {}) {}

  async snapshot(input: DesktopSkillSnapshotInput): Promise<DesktopSkillSnapshot> {
    void input
    return filterOutsideProjectWorkspaces(
      await withDaemonRetry((client) => client.development.listSkills()),
      this.documentsPath()
    )
  }

  async remove(input: DesktopSkillRemoveInput): Promise<DesktopSkillSnapshot> {
    return filterOutsideProjectWorkspaces(
      await withDaemonRetry((client) =>
        client.development.removeSkill(input.id, { expectedContent: input.expectedContent })
      ),
      this.documentsPath()
    )
  }

  private documentsPath(): string {
    return this.options.documentsPath ?? app.getPath("documents")
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
  documentsPath: string
): DesktopSkillSnapshot {
  const projects = snapshot.projects.filter(
    (project) => !isOutsideProjectWorkspacePath(project.path, documentsPath)
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
