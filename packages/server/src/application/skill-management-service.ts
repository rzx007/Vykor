import { createHash } from "node:crypto";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { getSkillsDir } from "@vykor/core";
import {
  BUNDLED_SKILLS,
  SkillLoader,
  SkillRegistry,
  standardUserSkillDirs,
} from "@vykor/skills";
import type {
  SkillInfo,
  SkillProject,
  SkillService,
  SkillSnapshot,
  SkillSource,
} from "./settings-api.js";

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
    this.bundledSkills = options.bundledSkills ?? BUNDLED_SKILLS;
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
    await unlink(target);
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
        output.push(desktopSkill({ ...skill, path }, source, project?.info));
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
    } catch {
      warnings.push(`项目不存在或不是目录：${project.path}`);
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
