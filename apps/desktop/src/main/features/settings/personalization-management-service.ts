import { SystemResource } from "@vykor/daemon-admin/configuration"
import { KnowledgeResource } from "@vykor/daemon-admin/knowledge"
import { ProjectResource } from "../session/project-resource"
import { mkdir, stat } from "node:fs/promises"
import { shell } from "electron"
import { inspectPersonalizationSettings, saveMemoryConfiguration } from "@vykor/server"
import type {
  PersonalizationManagementAPI,
  PersonalizationManagementSnapshot,
} from "../../../shared/personalization-management-types"
import { desktopSessionService } from "../session/session-service"

export class PersonalizationManagementService implements PersonalizationManagementAPI {
  private async context(projectId?: string) {
    if (projectId !== undefined && (typeof projectId !== "string" || !projectId))
      throw new Error("请选择有效项目。")
    const agent = await desktopSessionService.agentClient()
    const transport = await desktopSessionService.daemonTransport(agent)
    const project = projectId
      ? (await new ProjectResource(transport).list()).find((item) => item.id === projectId)
      : undefined
    if (projectId && !project) throw new Error("选定项目不存在，请重新选择。")
    if (project && !(await stat(project.path)).isDirectory())
      throw new Error("选定项目目录不可用。")
    return { protocol: agent.protocol, project, settings: new SystemResource(transport), knowledge: new KnowledgeResource(transport) }
  }
  async snapshot(input: { projectId?: string } = {}): Promise<PersonalizationManagementSnapshot> {
    const { settings, protocol, knowledge, project } = await this.context(input.projectId)
    const [user, capabilities] = await Promise.all([
      settings.getSettings(),
      protocol.capabilities(),
    ])
    const configuration = await inspectPersonalizationSettings({
      cwd: project?.path,
      userMemory: user.memory as NonNullable<
        Parameters<typeof inspectPersonalizationSettings>[0]
      >["userMemory"],
    })
    const memories = project ? await knowledge.listMemory({ cwd: project.path }) : undefined
    return {
      ...configuration,
      projectId: project?.id,
      projectPath: project?.path,
      directory: memories?.directory,
      entries: memories?.entries ?? [],
      managementAvailable: (capabilities.features.memoryManagement ?? 0) >= 1,
    }
  }
  async updateConfiguration(
    input: Parameters<PersonalizationManagementAPI["updateConfiguration"]>[0]
  ) {
    const { settings, project } = await this.context(input.projectId)
    await saveMemoryConfiguration({
      cwd: project?.path,
      value: input.value,
      expected: input.expected as Parameters<typeof saveMemoryConfiguration>[0]["expected"],
    })
    // Reload the existing daemon settings and invalidate warm runtimes for subsequent requests.
    await settings.patchSettings({ memory: {} })
    return this.snapshot({ projectId: input.projectId })
  }
  async updateEntry(input: Parameters<PersonalizationManagementAPI["updateEntry"]>[0]) {
    const { knowledge, project } = await this.context(input.projectId)
    if (!project) throw new Error("请先选择记忆所属项目。")
    await knowledge.updateMemory({
      cwd: project.path,
      id: input.id,
      content: input.content,
      expectedRevision: input.expectedRevision,
    })
    return this.snapshot({ projectId: input.projectId })
  }
  async removeEntry(input: Parameters<PersonalizationManagementAPI["removeEntry"]>[0]) {
    const { knowledge, project } = await this.context(input.projectId)
    if (!project || typeof input.expectedRevision !== "string" || !input.expectedRevision)
      throw new Error("请选择具有版本信息的项目记忆。")
    await knowledge.removeMemory(input.id, {
      cwd: project.path,
      expectedRevision: input.expectedRevision,
    })
    return this.snapshot({ projectId: input.projectId })
  }
  async clearEntries(input: Parameters<PersonalizationManagementAPI["clearEntries"]>[0]) {
    const { knowledge, project } = await this.context(input.projectId)
    if (!project) throw new Error("请选择记忆所属项目。")
    await knowledge.clearMemory({ cwd: project.path, expectedEntries: input.expectedEntries })
    return this.snapshot({ projectId: input.projectId })
  }
  async openRule(input: { projectId: string; path: string }) {
    const { project } = await this.context(input.projectId)
    if (
      !project ||
      !(await inspectPersonalizationSettings({ cwd: project.path })).rules.includes(input.path)
    )
      throw new Error("这不是当前项目实际加载的指令文件。")
    if (!(await stat(input.path)).isFile()) throw new Error("指令文件不可用。")
    const error = await shell.openPath(input.path)
    if (error) throw new Error(error)
  }
  async openDirectory(input: { projectId: string }) {
    const { project, knowledge } = await this.context(input.projectId)
    if (!project) throw new Error("请选择记忆所属项目。")
    const { directory } = await knowledge.listMemory({ cwd: project.path })
    await mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  }
}
export const personalizationManagementService = new PersonalizationManagementService()
