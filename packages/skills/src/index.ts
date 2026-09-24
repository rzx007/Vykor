import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { BUNDLED_SKILLS } from "./bundled.js";

export { BUNDLED_SKILLS } from "./bundled.js";

export type SkillSource = "bundled" | "user" | "project" | "plugin";

/**
 * 定义技能（Skill）的结构信息。
 */
export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  path: string;
  source?: SkillSource;
  metadata?: Record<string, unknown>;
  /** 是否允许用户通过 /<name> 斜杠命令调用。缺省 true。 */
  userInvocable: boolean;
  /** 是否禁止模型在 system prompt / Skill 工具中发现并调用。缺省 false。 */
  disableModelInvocation: boolean;
  /** 可选的 model 覆盖。 */
  model?: string;
  /** 可选的参数提示（用于命令补全/帮助）。 */
  argumentHint?: string;
  /** 可选的命令名（用于斜杠命令路由，缺省用 name）。 */
  commandName?: string;
  /** 可选的展示名。 */
  displayName?: string;
}

/**
 * 加载技能时的配置选项。
 */
export interface SkillLoadOptions {
  paths: string[];
  recursive?: boolean;
}

export interface SkillMarkdownLoadOptions {
  source?: SkillSource;
}

export interface SkillDirectoryLoadOptions extends SkillMarkdownLoadOptions {
  recursive?: boolean;
}

export interface CreateSkillRegistrySnapshotOptions {
  bundled?: boolean | readonly SkillDefinition[];
  baseline?: readonly SkillDefinition[];
  plugins?: readonly SkillDefinition[];
  userDirs?: readonly string[];
  userDir?: string;
  projectDirs?: readonly string[];
}

/**
 * 技能注册表，用于管理已加载的技能定义。
 * 提供技能的注册、查询、获取列表和注销功能。
 */
export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private nonPluginSkills = new Map<string, SkillDefinition>();

  /**
   * 注册一个技能定义到注册表中。
   * @param skill - 要注册的技能定义对象。
   */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    if (skill.source !== "plugin") this.nonPluginSkills.set(skill.name, skill);
  }

  /**
   * 注册全部内置（bundled）技能。
   *
   * 来源优先级：bundled < user < project。bundled 应**最先**注册，
   * 之后 user / project 技能用 register() 按名覆盖（后注册者赢）。
   */
  registerBundled(): void {
    for (const skill of BUNDLED_SKILLS) {
      this.register(skill);
    }
  }

  /**
   * 根据名称获取单个技能定义。
   * @param name - 技能的名称。
   * @returns 如果找到则返回技能定义，否则返回 undefined。
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  resolve(name: string): SkillDefinition | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const skill =
      this.get(trimmed) ??
      this.get(trimmed.toLowerCase()) ??
      this.get(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
    if (skill) return skill;
    return this.getAll().find((candidate) => candidate.commandName === trimmed);
  }

  /**
   * 根据已注册技能当前赢家的文件路径解析技能。
   * 同名技能被覆盖后，旧路径不会保留为可解析目标。
   */
  resolvePath(pathValue: string): SkillDefinition | undefined {
    if (!pathValue.trim()) return undefined;
    const pathKey = normalizePathKey(pathValue);
    return this.getAll().find(
      (skill) => Boolean(skill.path) && normalizePathKey(skill.path) === pathKey,
    );
  }

  /**
   * 获取所有已注册的技能定义列表，并按名称字母顺序排序。
   * @returns 只读的技能定义数组。
   */
  getAll(): readonly SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Keep the ordinary winner even when a plugin overrides its name. */
  getNonPluginSkills(): readonly SkillDefinition[] {
    return [...this.nonPluginSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Filter ownership before merging these layers into a Run's name winners. */
  getRunCandidates(): readonly SkillDefinition[] {
    return [...this.getNonPluginSkills(), ...this.getAll().filter((skill) => skill.source === "plugin")];
  }

  /**
   * 检查指定名称的技能是否已注册。
   * @param name - 技能的名称。
   * @returns 如果存在则返回 true，否则返回 false。
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 从注册表中注销指定名称的技能。
   * @param name - 要注销的技能名称。
   */
  unregister(name: string): void {
    this.skills.delete(name);
    this.nonPluginSkills.delete(name);
  }

  /**
   * 解析并获取指定技能的内容字符串。
   * @param name - 技能的名称。
   * @returns 技能的内容字符串，如果技能不存在则返回 undefined。
   */
  resolveContent(name: string): string | undefined {
    const skill = this.skills.get(name);
    return skill?.content;
  }

  /**
   * 构建"给模型看"的技能列表（进 system prompt 的 skillsList 来源）：
   * 过滤掉 disableModelInvocation 为 true 的技能，使模型不会主动发现/调用它们
   * （它们仍可被用户通过 /<name> 斜杠调用）。映射成 {name, description}。
   */
  modelVisibleList(): Array<{ name: string; description: string }> {
    return this.getAll()
      .filter((s) => s.disableModelInvocation !== true)
      .map((s) => ({ name: s.name, description: s.description }));
  }
}

/**
 * 解析后的技能元数据接口。
 */
export interface ParsedSkillMeta {
  name: string;
  description: string;
  /** 缺省 true（对齐 Python user_invocable=True）。 */
  userInvocable: boolean;
  /** 缺省 false（对齐 Python disable_model_invocation=False）。 */
  disableModelInvocation: boolean;
  model?: string;
  argumentHint?: string;
  commandName?: string;
  displayName?: string;
}

/**
 * 解析 frontmatter 布尔值。true/1/yes/on → true，false/0/no/off → false。
 * 无法识别时返回 fallback。
 */
function parseFrontmatterBool(raw: string, fallback: boolean): boolean {
  const v = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * 把 frontmatter 的 key 归一化：去掉连字符/下划线差异，统一小写。
 * 例如 `user-invocable` 和 `user_invocable` 都归一为 `userinvocable`。
 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, "");
}

/**
 * 从 Markdown 内容中解析技能的名称和描述。
 * 支持 Frontmatter 格式（--- 包裹的 YAML 头部）提取元数据。
 * 如果没有 Frontmatter，则尝试从第一个标题或第一段文本中提取。
 *
 * @param defaultName - 默认的名称，通常由文件名生成，当内容中未指定名称时使用。
 * @param content - Markdown 文件的完整内容字符串。
 * @returns 包含解析后的 name 和 description 的对象。
 */
export function parseSkillMarkdown(
  defaultName: string,
  content: string
): ParsedSkillMeta {
  let name = defaultName;
  let description = "";
  let bodyStart = 0;

  // 扩展字段（带默认值，对齐 Python）
  let userInvocable = true;
  let disableModelInvocation = false;
  let model: string | undefined;
  let argumentHint: string | undefined;
  let commandName: string | undefined;
  let displayName: string | undefined;

  // 尝试解析 Frontmatter 部分
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const lines = content.split("\n");
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx > 0) {
      const frontmatter = parseYamlRecord(lines.slice(1, endIdx).join("\n"));
      for (const [rawKey, rawValue] of Object.entries(frontmatter)) {
        const key = normalizeKey(rawKey);
        const val = frontmatterString(rawValue);
        switch (key) {
          case "name":
            if (val) name = val;
            break;
          case "description":
            if (val) description = val;
            break;
          case "userinvocable":
            userInvocable = parseFrontmatterBool(val, true);
            break;
          case "disablemodelinvocation":
            disableModelInvocation = parseFrontmatterBool(val, false);
            break;
          case "model":
            if (val) model = val;
            break;
          case "argumenthint":
            if (val) argumentHint = val;
            break;
          case "commandname":
            if (val) commandName = val;
            break;
          case "displayname":
            if (val) displayName = val;
            break;
        }
      }
      bodyStart = endIdx + 1;
    }
  }

  // 如果没有从 Frontmatter 获取到描述，则从正文中提取
  if (!description) {
    const lines = content.split("\n").slice(bodyStart);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ") && (name === defaultName || !name)) {
        name = trimmed.slice(2).trim() || name;
        continue;
      }
      if (trimmed.startsWith("---") || trimmed.startsWith("#") || trimmed === "") {
        continue;
      }
      description = trimmed.slice(0, 200);
      break;
    }
  }

  if (!description) description = `Skill: ${name}`;
  return {
    name,
    description,
    userInvocable,
    disableModelInvocation,
    model,
    argumentHint,
    commandName,
    displayName,
  };
}

function parseYamlRecord(source: string): Record<string, unknown> {
  try {
    const value = parseYaml(source);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function frontmatterString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return "";
}

/**
 * 技能加载器，负责从文件系统读取 Markdown 文件并加载到注册表中。
 */
export class SkillLoader {
  private registry: SkillRegistry;

  /**
   * 创建 SkillLoader 实例。
   * @param registry - 用于注册加载后技能的 SkillRegistry 实例。
   */
  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  /**
   * 从单个 Markdown 文件加载技能定义，并自动注册到注册表中。
   * @param filePath - Markdown 文件的路径。
   * @returns 如果加载成功则返回 SkillDefinition，否则返回 undefined。
   */
  async loadFromMarkdown(
    filePath: string,
    options: SkillMarkdownLoadOptions = {},
  ): Promise<SkillDefinition | undefined> {
    const content = await this.readFile(filePath);
    if (!content) return undefined;

    const skill = this.parseMarkdown(filePath, content, options);
    if (skill) {
      this.registry.register(skill);
    }
    return skill;
  }

  /**
   * 从指定目录加载所有 Markdown 文件作为技能。
   * @param dirPath - 要扫描的目录路径。
   * @param recursive - 是否递归扫描子目录，默认为 false。
   * @returns 加载成功的技能定义数组。
   */
  async loadFromDirectory(
    dirPath: string,
    recursiveOrOptions?: boolean | SkillDirectoryLoadOptions
  ): Promise<SkillDefinition[]> {
    const options: SkillDirectoryLoadOptions =
      typeof recursiveOrOptions === "boolean"
        ? { recursive: recursiveOrOptions }
        : recursiveOrOptions ?? {};
    const files = await this.discoverMarkdownFiles(dirPath, options.recursive);
    const skills: SkillDefinition[] = [];
    for (const file of files) {
      const skill = await this.loadFromMarkdown(file, options);
      if (skill) skills.push(skill);
    }
    return skills;
  }

  /**
   * 解析 Markdown 内容并构建 SkillDefinition 对象。
   * @param filePath - 文件路径，用于生成默认名称。
   * @param content - 文件内容字符串。
   * @returns 构建好的 SkillDefinition 对象。
   */
  private parseMarkdown(
    filePath: string,
    content: string,
    options: SkillMarkdownLoadOptions = {},
  ): SkillDefinition {
    const defaultName = this.pathToName(filePath);
    const meta = parseSkillMarkdown(defaultName, content);
    return {
      name: meta.name,
      description: meta.description,
      content,
      path: filePath,
      ...(options.source !== undefined ? { source: options.source } : {}),
      userInvocable: meta.userInvocable,
      disableModelInvocation: meta.disableModelInvocation,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.argumentHint !== undefined ? { argumentHint: meta.argumentHint } : {}),
      ...(meta.commandName !== undefined ? { commandName: meta.commandName } : {}),
      ...(meta.displayName !== undefined ? { displayName: meta.displayName } : {}),
    };
  }

  /**
   * 从文件路径中提取默认技能名称。
   *
   * 普通 Markdown 文件使用文件名：`skills/review.md` → `review`。
   * 目录型技能使用目录名：`skills/review/SKILL.md` → `review`。
   */
  private pathToName(filePath: string): string {
    if (basename(filePath).toLowerCase() === "skill.md") {
      return basename(dirname(filePath));
    }
    return basename(filePath, ".md");
  }

  /**
   * 异步读取文件内容。
   * @param path - 文件路径。
   * @returns 文件内容的 UTF-8 字符串，如果读取失败则返回 undefined。
   */
  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return undefined;
    }
  }

  /**
   * 发现指定目录下的技能 Markdown 文件。
   *
   * 支持两种布局：
   * - `skills/foo.md`
   * - `skills/foo/SKILL.md`
   *
   * recursive=true 时只把子目录里的 `SKILL.md` 视为技能入口，避免把
   * `references/*.md`、`docs/*.md` 之类辅助文档误注册成技能。
   *
   * @param dirPath - 要扫描的目录路径。
   * @param recursive - 是否扫描子目录中的 SKILL.md。
   * @returns 找到的 Markdown 文件路径数组，已排序。
   */
  async discoverMarkdownFiles(
    dirPath: string,
    recursive?: boolean
  ): Promise<string[]> {
    try {
      const resolvedDir = resolve(dirPath);
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dirPath, entry.name);
        // 路径穿越防护：确保解析后的路径在 dirPath 内（防止 symlink 或 .. 逃逸）。
        const resolvedFull = resolve(full);
        if (!resolvedFull.startsWith(resolvedDir + sep)) continue;
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(full);
        } else if (recursive && entry.isDirectory()) {
          const nestedEntries = await this.discoverMarkdownFiles(full, false);
          files.push(...nestedEntries.filter((file) => basename(file).toLowerCase() === "skill.md"));
          if (!nestedEntries.some((file) => basename(file).toLowerCase() === "skill.md")) {
            files.push(...await this.discoverSkillEntryFiles(full, resolvedDir));
          }
        }
      }
      return files.sort();
    } catch {
      return [];
    }
  }

  private async discoverSkillEntryFiles(dirPath: string, rootDir: string): Promise<string[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dirPath, entry.name);
        const resolvedFull = resolve(full);
        if (!resolvedFull.startsWith(rootDir + sep)) continue;
        if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
          files.push(full);
        } else if (entry.isDirectory()) {
          files.push(...await this.discoverSkillEntryFiles(full, rootDir));
        }
      }
      return files.sort();
    } catch {
      return [];
    }
  }
}

/** Rebuild a registry from immutable sources so removed filesystem Skills disappear. */
export async function createSkillRegistrySnapshot(
  options: CreateSkillRegistrySnapshotOptions = {},
): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  const bundled = options.bundled ?? true;
  if (bundled === true) {
    registry.registerBundled();
  } else if (bundled !== false) {
    for (const skill of bundled) registry.register(skill);
  }
  for (const skill of options.baseline ?? []) registry.register(skill);
  for (const skill of options.plugins ?? []) registry.register(skill);

  const loader = new SkillLoader(registry);
  for (const directory of uniqueDirectories([
    ...(options.userDirs ?? []),
    ...(options.userDir ? [options.userDir] : []),
  ])) {
    await loader.loadFromDirectory(directory, {
      source: "user",
      recursive: true,
    });
  }
  for (const directory of options.projectDirs ?? []) {
    await loader.loadFromDirectory(directory, {
      source: "project",
      recursive: true,
    });
  }
  return registry;
}

export function standardUserSkillDirs(homeDir = homedir()): string[] {
  return [
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".config", "agents", "skills"),
  ];
}

function uniqueDirectories(directories: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const directory = resolve(directories[index]!);
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    output.unshift(directory);
  }
  return output;
}

/**
 * 从 cwd 向上遍历到 git-root，收集每一层的 project skill 目录。
 * 返回的目录列表按"低优先级在前、高优先级在后"排序（root 先、cwd 后），
 * 调用方按顺序加载时，cwd 层技能会覆盖 git-root 层的同名技能。
 *
 * 每层收集顺序：.agents/skills → .vykor/skills。
 *
 * 若祖先链上没有 `.git`，只扫描 cwd 自身，避免把家目录下的个人技能
 * （如 `~/.vykor/skills`）误标成 project。个人技能目录始终排除。
 */
export async function findProjectSkillDirs(cwd: string): Promise<string[]> {
  const levels: string[] = [];
  let current = resolve(cwd);
  let foundGitRoot = false;

  while (true) {
    levels.push(current);
    // 遇到 .git 目录/文件即停止（git-root 标志）。
    try {
      await stat(join(current, ".git"));
      foundGitRoot = true;
      break;
    } catch {}
    const parent = dirname(current);
    if (parent === current) break; // 到达文件系统根
    current = parent;
  }

  // 无 git-root 时不是项目树：只保留 cwd，不要扫到家目录/盘符根。
  const orderedLevels = foundGitRoot ? levels.reverse() : [resolve(cwd)];
  const excluded = personalSkillDirectories();

  const dirs: string[] = [];
  for (const level of orderedLevels) {
    for (const dir of [
      join(level, ".agents", "skills"),
      join(level, ".vykor", "skills"),
    ]) {
      if (excluded.has(normalizePathKey(dir))) continue;
      dirs.push(dir);
    }
  }
  return dirs;
}

/** 与 user 源加载路径对齐；这些目录绝不能再被标成 project。 */
function personalSkillDirectories(): Set<string> {
  const configDir =
    process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  const home = homedir();
  return new Set(
    [
      join(configDir, "skills"),
      join(home, ".agents", "skills"),
      join(home, ".config", "agents", "skills"),
    ].map(normalizePathKey),
  );
}

function normalizePathKey(pathValue: string): string {
  const resolved = resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 支持的 Frontmatter 格式：
 * 
---
name: git-workflow
description: Git 工作流程指南
userInvocable: true
disableModelInvocation: false
model: claude-3-opus
argumentHint: <branch-name>
commandName: git
displayName: Git 助手
---

# 实际内容... 
 */
