import type {
  SkillInfo,
  SkillMarketplaceEntry,
  SkillMarketplaceInstallInput,
  SkillProject,
  SkillSnapshot,
} from "@vykor/application-client"

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
export type DesktopSkillMarketplaceEntry = SkillMarketplaceEntry
/** null means the connected daemon does not expose the marketplace endpoint. */
export type DesktopSkillMarketplaceCatalog = DesktopSkillMarketplaceEntry[] | null
export type DesktopSkillMarketplaceInstallInput = SkillMarketplaceInstallInput
