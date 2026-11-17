import type { SkillMarketplaceInstallInput } from "@vykor/domain-contracts/skills";
import { ProtocolValidationError } from "../requests/requests.js";

export type {
  SkillMarketplaceEntry,
  SkillMarketplaceInstallInput,
  SkillMarketplaceSelection,
} from "@vykor/domain-contracts/skills";

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
