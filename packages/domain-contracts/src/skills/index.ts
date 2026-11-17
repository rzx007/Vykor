export interface SkillMarketplaceSelection {
  id: string;
  version: string;
  sha256: string;
}

export interface SkillMarketplaceEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  license: string;
  requirements?: string;
  source: { repository: string; commit: string; path: string };
  artifact: { url: string; size: number; sha256: string };
}

export type SkillMarketplaceInstallInput = SkillMarketplaceSelection & (
  | { scope: "personal" }
  | { scope: "project"; projectPath: string }
);
