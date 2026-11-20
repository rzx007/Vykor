import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  downloadMarketplaceZip,
  extractMarketplaceZip,
  OFFICIAL_SKILL_MARKETPLACE_SOURCE,
  readMarketplaceCatalog,
  type MarketplaceRequest,
} from "@vykor/plugin-sources";
import type {
  SkillMarketplaceEntry,
  SkillMarketplaceSelection,
} from "@vykor/domain-contracts/skills";
import { parseSkillMarkdown } from "@vykor/skills";

const source = OFFICIAL_SKILL_MARKETPLACE_SOURCE;
const assetPrefix = "https://github.com/rzx007/vykor-skills/releases/download/";
const marker = ".vykor-skill-install.json";
const shaPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

interface InstalledSkill extends SkillMarketplaceSelection {
  treeDigest: string;
  source: SkillMarketplaceEntry["source"];
}

function skillName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0;
}

function sourcePath(value: unknown): value is string {
  return text(value, 1024) && (value === "." || value.split("/").every((part) =>
    part !== "." && part !== ".." && /^[^\\:\u0000-\u001f]+$/.test(part)));
}

export async function listSkillMarketplace(request?: MarketplaceRequest): Promise<SkillMarketplaceEntry[]> {
  const bytes = await readMarketplaceCatalog(source, request);
  const index = JSON.parse(bytes.toString("utf8")) as {
    schemaVersion: unknown;
    release: string;
    skills: SkillMarketplaceEntry[];
  } | null;
  if (index?.schemaVersion !== 1 || typeof index.release !== "string"
    || !/^skills-v[1-9][0-9]*$/.test(index.release)
    || !Array.isArray(index.skills) || index.skills.length > 100) {
    throw new Error("技能市场清单格式无效。");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const skill of index.skills) {
    if (!skillName(skill?.id) || !skillName(skill.name)
      || ids.has(skill.id) || names.has(skill.name)
      || !text(skill.version, 32) || !versionPattern.test(skill.version)
      || !text(skill.displayName, 100) || !text(skill.description, 500)
      || !text(skill.license, 80) || (skill.requirements !== undefined && !text(skill.requirements, 500))
      || !text(skill.source?.repository, 250)
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(skill.source.repository)
      || !text(skill.source.commit, 40) || !/^[a-f0-9]{40}$/.test(skill.source.commit)
      || !sourcePath(skill.source.path)
      || skill.artifact?.url !== `${assetPrefix}${index.release}/${skill.id}-${skill.version}.zip`
      || !Number.isSafeInteger(skill.artifact.size) || skill.artifact.size <= 0
      || skill.artifact.size > 100 * 1024 * 1024
      || typeof skill.artifact.sha256 !== "string" || !shaPattern.test(skill.artifact.sha256)) {
      throw new Error("技能市场条目无效，请稍后刷新。");
    }
    ids.add(skill.id);
    names.add(skill.name);
  }
  return index.skills;
}

export async function readInstalledMarketplaceSkill(directory: string): Promise<InstalledSkill | undefined> {
  try {
    const file = join(directory, marker);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4096) return undefined;
    const record = JSON.parse(await readFile(file, "utf8")) as InstalledSkill | null;
    if (record && skillName(record.id)
      && text(record.version, 32) && versionPattern.test(record.version)
      && typeof record.sha256 === "string" && shaPattern.test(record.sha256)
      && typeof record.treeDigest === "string" && shaPattern.test(record.treeDigest)) {
      return record;
    }
  } catch {
    // Existing hand-managed skills have no market record.
  }
  return undefined;
}

async function treeDigest(root: string): Promise<string> {
  const tree = createHash("sha256");
  let count = 0;
  let bytes = 0;
  async function visit(directory: string, prefix: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
    for (const item of entries) {
      if (!prefix && item.name === marker) continue;
      const path = join(directory, item.name);
      const relative = prefix + item.name;
      if (++count > 5000) throw new Error("技能目录文件数量超出限制。");
      if (item.isDirectory()) {
        tree.update(JSON.stringify([relative + "/"]));
        await visit(path, relative + "/");
        continue;
      }
      if (!item.isFile()) throw new Error("技能目录包含链接或特殊文件。");
      if (prefix && item.name.toLowerCase() === "skill.md") {
        throw new Error("安装包应只包含一个根目录 SKILL.md。");
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) {
        bytes += chunk.length;
        if (bytes > 250 * 1024 * 1024) throw new Error("技能目录大小超出限制。");
        hash.update(chunk);
      }
      tree.update(JSON.stringify([relative, hash.digest("hex")]));
    }
  }
  await visit(root, "");
  return tree.digest("hex");
}

export async function isSkillDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`技能目录已存在且不是普通目录：${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertOriginal(directory: string, previous: InstalledSkill) {
  if (await treeDigest(directory) !== previous.treeDigest) {
    throw new Error(`技能文件已在本地修改，请先备份并移走目录：${directory}`);
  }
}

async function marketplaceTarget(root: string, skill: SkillMarketplaceEntry) {
  const target = join(root, skill.name);
  const rollback = join(dirname(root), `.skill-rollback-${skill.name}`);
  const existing = await isSkillDirectory(target) ? target
    : await isSkillDirectory(rollback) ? rollback : undefined;
  const previous = existing ? await readInstalledMarketplaceSkill(existing) : undefined;
  if (existing && previous?.id !== skill.id) {
    throw new Error(existing === target ? `同名技能已存在：${target}` : `请先检查技能更新备份：${rollback}`);
  }
  return { target, rollback, existing, previous };
}

function matchesSelection(previous: InstalledSkill | undefined, skill: SkillMarketplaceEntry): boolean {
  if (previous?.version !== skill.version) return false;
  if (previous.sha256 !== skill.artifact.sha256) {
    throw new Error("市场中同版本技能的摘要已变化，请刷新市场。");
  }
  return true;
}

export async function needsMarketplaceArchive(root: string, skill: SkillMarketplaceEntry): Promise<boolean> {
  const { previous } = await marketplaceTarget(root, skill);
  return !matchesSelection(previous, skill);
}

export async function stageMarketplaceSkill(
  skill: SkillMarketplaceEntry,
  resolveRoot: () => Promise<string>,
  request?: MarketplaceRequest,
): Promise<string> {
  const archive = await downloadMarketplaceZip(source, skill.artifact, request);
  try {
    const root = await resolveRoot();
    const staging = await mkdtemp(join(dirname(root), ".skill-install-"));
    const staged = join(staging, "contents");
    try {
      await mkdir(staged);
      await extractMarketplaceZip(archive.path, staged);
      const filename = join(staged, "SKILL.md");
      const info = await lstat(filename);
      if (!info.isFile() || info.size > 1024 * 1024
        || parseSkillMarkdown("", await readFile(filename, "utf8")).name !== skill.name
        || !(await lstat(join(staged, "LICENSE"))).isFile()) {
        throw new Error("技能安装包的 SKILL.md 或许可证与市场条目不匹配。");
      }
      const metadata: InstalledSkill = {
        id: skill.id, version: skill.version, sha256: skill.artifact.sha256,
        treeDigest: await treeDigest(staged), source: skill.source,
      };
      await writeFile(join(staged, marker), JSON.stringify(metadata), { flag: "wx" });
      return staging;
    } catch (error) {
      await cleanupMarketplaceStage(staging);
      throw error;
    }
  } finally {
    await archive.cleanup().catch(() => undefined);
  }
}

export async function commitMarketplaceSkill(root: string, skill: SkillMarketplaceEntry, staging?: string): Promise<boolean> {
  const { target, rollback, existing, previous } = await marketplaceTarget(root, skill);
  const unchanged = matchesSelection(previous, skill);
  if (existing && previous) await assertOriginal(existing, previous);
  if (unchanged) {
    if (existing !== rollback) return false;
    await rename(rollback, target);
    return true;
  }
  if (!staging || !await isSkillDirectory(join(staging, "contents"))) {
    throw new Error("技能目录已变化，请刷新后重试。");
  }
  if (existing === target) {
    if (await isSkillDirectory(rollback)) {
      const obsolete = await readInstalledMarketplaceSkill(rollback);
      if (obsolete?.id !== skill.id) throw new Error(`请先检查技能更新备份：${rollback}`);
      await rename(rollback, join(staging, "obsolete"));
    }
    await rename(target, rollback);
  }
  try {
    await rename(join(staging, "contents"), target);
  } catch (error) {
    if (previous) await rename(rollback, target);
    throw error;
  }
  if (previous) {
    // Keep the recovery copy intact if it cannot be moved. Recursive cleanup
    // can only touch files inside the staging directory, after the lock is released.
    await rename(rollback, join(staging, "replaced")).catch(() => undefined);
  }
  return true;
}

export async function cleanupMarketplaceStage(staging?: string): Promise<void> {
  if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
}

export async function uninstallMarketplaceSkill(directory: string, record: InstalledSkill): Promise<void> {
  await assertOriginal(directory, record);
  const staging = await mkdtemp(join(dirname(dirname(directory)), ".skill-remove-"));
  try {
    await rename(directory, join(staging, "contents"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function ensureSkillRoot(owner: string, parts: string[]): Promise<string> {
  let directory = owner;
  for (const part of parts) {
    directory = join(directory, part);
    if (!await isSkillDirectory(directory)) {
      try {
        await mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await isSkillDirectory(directory)) throw error;
      }
    }
  }
  return directory;
}
