import type { SkillInfo, SkillProject, SkillSnapshot } from "@rzx/client"

export type DesktopSkillInfo = SkillInfo
export type DesktopSkillProject = SkillProject

export interface DesktopSkillSnapshotInput {
  projectPath: string
}

export interface DesktopSkillRemoveInput {
  id: string
  expectedContent: string
  projectPath: string
}

export type DesktopSkillSnapshot = SkillSnapshot
