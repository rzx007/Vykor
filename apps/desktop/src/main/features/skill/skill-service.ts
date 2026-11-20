import { VykorApiError, type VykorClient } from "@rzx/client"
import type {
  DesktopSkillMarketplaceCatalog,
  DesktopSkillMarketplaceInstallInput,
  DesktopSkillRemoveInput,
  DesktopSkillSnapshot,
  DesktopSkillSnapshotInput,
} from "../../../shared/skill-types"
import { getDataRoot, isHiddenManagedProjectPath } from "@vykor/host-config/paths"
import { app } from "electron"
import { isLegacyOutsideProjectWorkspacePath } from "../session/outside-project-workspace"
import { desktopSessionService } from "../session/session-service"

import { SkillResource } from "./skill-resource"

type SkillClient = Pick<VykorClient, "runtime"> & { development: SkillResource }

async function skillClient(agent: VykorClient): Promise<SkillClient> {
  return { runtime: agent.runtime, development: new SkillResource(await desktopSessionService.daemonTransport(agent)) }
}

export interface DesktopSkillServiceOptions {
  dataRoot?: string
}

export class DesktopSkillService {
  constructor(private readonly options: DesktopSkillServiceOptions = {}) {}

  async marketplace(): Promise<DesktopSkillMarketplaceCatalog> {
    try {
      return await withDaemonRetry((client) => client.development.listSkillMarketplace())
    } catch (error) {
      if (error instanceof VykorApiError && error.status === 404) return null
      throw error
    }
  }

  async installMarketplace(
    input: DesktopSkillMarketplaceInstallInput
  ): Promise<DesktopSkillSnapshot> {
    const client = await skillClient(await desktopSessionService.agentClient())
    const result = await client.development.installMarketplaceSkill(input)
    return filterOutsideProjectWorkspaces(result, this.dataRoot())
  }

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

async function withDaemonRetry<T>(operation: (client: SkillClient) => Promise<T>): Promise<T> {
  try {
    return await operation(await skillClient(await desktopSessionService.agentClient()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await skillClient(await desktopSessionService.refreshAgentClient()))
  }
}

function filterOutsideProjectWorkspaces(
  snapshot: DesktopSkillSnapshot,
  dataRoot: string
): DesktopSkillSnapshot {
  const documentsDir = app.getPath("documents")
  const projects = snapshot.projects.filter(
    (project) =>
      !isLegacyOutsideProjectWorkspacePath(project.path, documentsDir) &&
      !isHiddenManagedProjectPath(project.path, dataRoot)
  )
  const projectKeys = new Set(projects.map((project) => pathKey(project.path)))

  return {
    warnings: snapshot.warnings,
    projects,
    skills: snapshot.skills.filter((skill) => {
      if (skill.source === "bundled" || skill.source === "standard" || skill.source === "personal")
        return true
      if (!skill.projectPath) return false
      return projectKeys.has(pathKey(skill.projectPath))
    }),
  }
}

function pathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}
