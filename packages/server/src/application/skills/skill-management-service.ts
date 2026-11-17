import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { getSkillsDir } from "@vykor/host-config";
import { isHiddenManagedProjectPath } from "@vykor/host-config/paths";
import type { MarketplaceRequest } from "@vykor/plugin-sources";
import type { SkillMarketplaceInstallInput } from "@vykor/protocol";
import {
  createBundledSkills,
  SkillLoader,
  SkillRegistry,
  standardUserSkillDirs,
} from "@vykor/skills";
import type {
  PreparedSkillMarketplaceInstall,
  SkillInfo,
  SkillProject,
  SkillService,
  SkillSnapshot,
  SkillSource,
} from "../settings-api.js";
import {
  cleanupMarketplaceStage,
  commitMarketplaceSkill,
  ensureSkillRoot,
  listSkillMarketplace,
  needsMarketplaceArchive,
  readInstalledMarketplaceSkill,
  stageMarketplaceSkill,
  uninstallMarketplaceSkill,
} from "./skill-marketplace.js";

interface ProjectCatalog {
  list(): Array<{ name: string; path: string }>;
}
interface SkillFixture {
  name: string;
  description: string;
  content: string;
  path: string;
}
export interface SkillManagementServiceOptions {
  projects: ProjectCatalog;
  configDir?: string;
  standardSkillsDirs?: readonly string[];
  bundledSkills?: readonly SkillFixture[];
  marketplaceRequest?: MarketplaceRequest;
}
interface ValidProject {
  info: SkillProject;
  root: string;
}

export class SkillManagementService implements SkillService {
  private readonly personalSkillsDir: string;
  private readonly configDir: string;
  private readonly bundledSkills: readonly SkillFixture[];
  private readonly standardSkillsDirs: readonly string[];

  constructor(private readonly options: SkillManagementServiceOptions) {
    const defaultSkillsDir = getSkillsDir();
    this.configDir = resolve(options.configDir ?? dirname(defaultSkillsDir));
    this.personalSkillsDir = options.configDir
      ? join(this.configDir, "skills")
      : resolve(defaultSkillsDir);
    this.standardSkillsDirs = options.standardSkillsDirs ?? standardUserSkillDirs();
    this.bundledSkills = options.bundledSkills ?? createBundledSkills(this.personalSkillsDir);
  }

  async list(): Promise<SkillSnapshot> {
    const warnings: string[] = [];
    const projects = await validProjects(
      this.options.projects.list(),
      warnings,
    );
    const skills: SkillInfo[] = this.bundledSkills.map((skill) =>
      desktopSkill(skill, "bundled"),
    );
    const seen = new Set<string>();
    for (const project of projects) {
      await this.load(
        join(project.root, ".agents", "skills"),
        "agent",
        skills,
        seen,
        warnings,
        project,
      );
      await this.load(
        join(project.root, ".claude", "skills"),
        "agent",
        skills,
        seen,
        warnings,
        project,
      );
      const managed = join(project.root, ".vykor", "skills");
      if (key(managed) !== key(this.personalSkillsDir)) {
        await this.load(managed, "project", skills, seen, warnings, project);
      }
    }
    for (const directory of uniqueDirectories(this.standardSkillsDirs, this.personalSkillsDir)) {
      await this.load(directory, "standard", skills, seen, warnings);
    }
    await this.load(this.personalSkillsDir, "personal", skills, seen, warnings);
    return { skills, projects: projects.map(({ info }) => info), warnings };
  }

  async listMarketplace() {
    return listSkillMarketplace(this.options.marketplaceRequest);
  }

  async prepareMarketplaceInstall(input: SkillMarketplaceInstallInput): Promise<PreparedSkillMarketplaceInstall> {
    const catalog = await this.listMarketplace();
    const skill = catalog.find((entry) => entry.id === input.id
      && entry.version === input.version && entry.artifact.sha256 === input.sha256);
    if (!skill) throw new Error("技能市场条目已变化，请刷新后重试。");

    const root = await this.marketplaceRoot(input);
    await this.assertNoMarketplaceCollision(root, skill.name);
    const revalidateRoot = () => this.marketplaceRoot(input, root);
    const staging = await needsMarketplaceArchive(root, skill)
      ? await stageMarketplaceSkill(skill, revalidateRoot, this.options.marketplaceRequest)
      : undefined;
    return {
      commit: async () => {
        await revalidateRoot();
        await this.assertNoMarketplaceCollision(root, skill.name);
        return commitMarketplaceSkill(root, skill, staging);
      },
      cleanup: () => cleanupMarketplaceStage(staging),
    };
  }

  private async marketplaceRoot(input: SkillMarketplaceInstallInput, expected?: string): Promise<string> {
    let owner: string;
    let parts: string[];
    if (input.scope === "project") {
      if (!isAbsolute(input.projectPath)) throw new Error("请选择已登记的项目。");
      const path = await realpath(input.projectPath).catch(() => undefined);
      const projects = await validProjects(this.options.projects.list(), []);
      const project = path && projects.find((item) => key(path) === key(item.root));
      const config = await realpath(this.configDir).catch(() => this.configDir);
      if (!project || isHiddenManagedProjectPath(project.root, this.configDir)
        || key(join(project.root, ".vykor")) === key(config)) {
        throw new Error("当前项目不可安装技能，请选择已登记的项目。");
      }
      owner = project.root;
      parts = [".vykor", "skills"];
    } else {
      await mkdir(this.configDir, { recursive: true });
      owner = await realpath(this.configDir);
      parts = ["skills"];
    }
    if (expected && key(join(owner, ...parts)) !== key(expected)) {
      throw new Error("技能安装目录已变化，请重新选择安装范围。");
    }
    return ensureSkillRoot(owner, parts);
  }

  private async assertNoMarketplaceCollision(root: string, name: string): Promise<void> {
    const installed = await new SkillLoader(new SkillRegistry()).loadFromDirectory(root, { recursive: true });
    if (installed.some((item) => item.name.toLowerCase() === name
      && key(item.path) !== key(join(root, name, "SKILL.md")))) {
      throw new Error("所选范围已存在同名技能，请先处理现有文件。");
    }
  }

  async remove(input: {
    id: string;
    expectedContent: string;
  }): Promise<SkillSnapshot> {
    const snapshot = await this.list();
    const item = snapshot.skills.find((candidate) => candidate.id === input.id);
    if (!item) throw new Error("找不到指定技能，请刷新后重试。");
    if (
      item.readOnly ||
      (item.source !== "project" && item.source !== "personal")
    ) {
      throw new Error("此技能来自只读目录，不能删除。");
    }
    const target = await this.secureTarget(item);
    const current = await readFile(target, "utf8");
    if (current !== input.expectedContent)
      throw new Error("技能已在其他位置修改，请刷新后重试。");
    if (item.marketplace) {
      const directory = dirname(target);
      const record = await readInstalledMarketplaceSkill(directory);
      if (!record || record.sha256 !== item.marketplace.sha256) {
        throw new Error("技能来源记录已改变，请刷新后重试。");
      }
      await uninstallMarketplaceSkill(directory, record);
    } else {
      await unlink(target);
    }
    return await this.list();
  }

  private async secureTarget(item: SkillInfo): Promise<string> {
    const target = await realpath(item.path);
    if (item.source === "personal") {
      await assertTarget(this.configDir, this.personalSkillsDir, target);
      return target;
    }
    if (!item.projectPath) throw new Error("技能缺少所属项目。");
    const project = await realpath(item.projectPath);
    await assertTarget(
      project,
      join(project, ".vykor", "skills"),
      target,
    );
    return target;
  }

  private async load(
    directory: string,
    source: Exclude<SkillSource, "bundled">,
    output: SkillInfo[],
    seen: Set<string>,
    warnings: string[],
    project?: ValidProject,
  ): Promise<void> {
    const loader = new SkillLoader(new SkillRegistry());
    const loaded = await loader.loadFromDirectory(directory, {
      source: source === "personal" ? "user" : "project",
      recursive: true,
    });
    for (const skill of loaded) {
      try {
        const path = await realpath(skill.path);
        if (seen.has(key(path))) continue;
        seen.add(key(path));
        const item = desktopSkill({ ...skill, path }, source, project?.info);
        if ((source === "project" || source === "personal")
          && basename(path) === "SKILL.md" && dirname(dirname(path)) === await realpath(directory)
          && key(skill.path) === key(join(directory, basename(dirname(path)), "SKILL.md"))) {
          const record = await readInstalledMarketplaceSkill(dirname(path));
          if (record) item.marketplace = { id: record.id, version: record.version, sha256: record.sha256 };
        }
        output.push(item);
      } catch {
        warnings.push(`无法读取技能文件：${skill.path}`);
      }
    }
  }
}

export function createSkillManagementService(
  options: SkillManagementServiceOptions,
): SkillManagementService {
  return new SkillManagementService(options);
}

async function validProjects(
  input: Array<{ name: string; path: string }>,
  warnings: string[],
): Promise<ValidProject[]> {
  const projects: ValidProject[] = [];
  const seen = new Set<string>();
  for (const project of input) {
    try {
      const root = await realpath(resolve(project.path));
      if (!(await stat(root)).isDirectory() || seen.has(key(root))) continue;
      seen.add(key(root));
      projects.push({
        root,
        info: { name: project.name.trim() || basename(root), path: root },
      });
    } catch (error) {
      // Removed projects are stale catalog entries, not skill-loading failures.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      warnings.push(`无法访问项目技能目录：${project.path}`);
    }
  }
  return projects;
}

function desktopSkill(
  skill: SkillFixture,
  source: SkillSource,
  project?: SkillProject,
): SkillInfo {
  return {
    id: `skill_${createHash("sha256").update(source).update("\0").update(key(skill.path)).update("\0").update(skill.name).digest("hex").slice(0, 24)}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    path: skill.path,
    source,
    readOnly: source === "bundled" || source === "agent" || source === "standard",
    ...(project
      ? { projectPath: project.path, projectName: project.name }
      : {}),
  };
}
async function assertTarget(
  owner: string,
  allowed: string,
  target: string,
): Promise<void> {
  const physicalOwner = await realpath(owner);
  const physicalAllowed = await realpath(allowed);
  if (!within(physicalOwner, physicalAllowed))
    throw new Error("技能目录通过符号链接指向了允许范围之外。");
  if (!within(physicalAllowed, target))
    throw new Error("技能文件位于允许范围之外。");
}
function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}
function key(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uniqueDirectories(
  directories: readonly string[],
  personalSkillsDir: string,
): string[] {
  const personalKey = key(personalSkillsDir);
  const seen = new Set<string>();
  return directories.flatMap((directory) => {
    const resolved = resolve(directory);
    const directoryKey = key(resolved);
    if (directoryKey === personalKey || seen.has(directoryKey)) return [];
    seen.add(directoryKey);
    return [resolved];
  });
}
