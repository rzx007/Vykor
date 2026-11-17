import { ProtocolValidationError } from "../requests/requests.js";

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

export function parseSkillMarketplaceInstall(value: Record<string, unknown>): SkillMarketplaceInstallInput {
  const { id, version, sha256, scope, projectPath } = value;
  if (typeof id !== "string" || id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
    || typeof version !== "string" || version.length > 32 || !/^\d+\.\d+\.\d+$/.test(version)
    || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ProtocolValidationError("技能或版本无效，请重新加载市场。");
  }
  if (scope === "personal" && projectPath === undefined) return { id, version, sha256, scope };
  if (scope === "project" && typeof projectPath === "string" && projectPath.trim() && projectPath.length <= 4096) {
    return { id, version, sha256, scope, projectPath };
  }
  throw new ProtocolValidationError("请选择有效的技能安装范围。");
}
