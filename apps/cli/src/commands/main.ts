import { randomUUID } from "node:crypto";
import type { ContentBlock, Settings } from "@openharness/core";
import { loadSettings, getSkillsDir, getDataDir } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { SkillRegistry, SkillLoader, findProjectSkillDirs, type SkillDefinition } from "@openharness/skills";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { resolveToolPath } from "@openharness/tools";
import { discoverInstalledNativePlugins, loadNativePlugin, verifyInstalledNativePlugin } from "@openharness/plugins";
import { isCoordinatorMode } from "@openharness/coordinator";
import { resolveBun } from "./resolveBun";
import { VERSION } from "../version";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";

type FrontendAttachment = {
  type?: "image" | string | null;
  path?: string | null;
  data?: string | null;
  media_type?: string | null;
  mime_type?: string | null;
};

interface MainOptions {
  model?: string;
  print?: boolean;
  name?: string;
  provider?: string;
  permissionMode?: string;
  coordinator?: boolean;
  maxTurns?: number;
  systemPrompt?: string;
  apiKey?: string;
  baseUrl?: string;
  apiFormat?: string;
  theme?: string;
  mcpConfig?: string;
  cwd?: string;
  effort?: string;
  verbose?: boolean;
  debug?: boolean;
  tui?: boolean;
  daemonUrl?: string;
  daemonToken?: string;
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string;
  disallowedTools?: string;
  outputFormat?: string;
  appendSystemPrompt?: string;
  plugins?: boolean;
  dryRun?: boolean;
  sessionId?: string;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const DEFAULT_MAX_IMAGE_ATTACHMENTS = 4;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function maxImageAttachments(): number {
  return positiveIntegerEnv("OPENHARNESS_MAX_IMAGE_ATTACHMENTS", DEFAULT_MAX_IMAGE_ATTACHMENTS);
}

function maxImageBytes(): number {
  return positiveIntegerEnv("OPENHARNESS_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES);
}

function normalizeMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function mediaTypeForPath(filePath: string, fallback?: string | null): string {
  if (fallback) return normalizeMediaType(fallback);
  const ext = filePath.split(/[.]/).pop()?.toLowerCase() ?? "";
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) {
    throw new Error(`Unsupported image attachment extension: ${ext || "(none)"}`);
  }
  return mediaType;
}

function splitDataUri(data: string, fallbackMediaType: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
  if (!match) return { mediaType: normalizeMediaType(fallbackMediaType), data };
  return { mediaType: normalizeMediaType(match[1]!), data: match[2]! };
}

function assertSupportedImage(mediaType: string): void {
  if (!IMAGE_EXTENSIONS[mediaType]) {
    throw new Error(`Unsupported image attachment type: ${mediaType}`);
  }
}

function assertImageSize(sizeBytes: number): void {
  const limit = maxImageBytes();
  if (sizeBytes > limit) {
    throw new Error(`Image attachment is too large (${sizeBytes} bytes, max ${limit} bytes).`);
  }
}

function imageAttachmentCacheDir(): string {
  return process.env.OPENHARNESS_IMAGE_ATTACHMENT_CACHE_DIR
    ?? join(getDataDir(), "attachments", "images");
}

async function cacheImageBuffer(buffer: Buffer, mediaType: string): Promise<string> {
  const dir = imageAttachmentCacheDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${randomUUID()}.${IMAGE_EXTENSIONS[mediaType] ?? "img"}`);
  await writeFile(target, buffer);
  return target;
}

async function cacheImageFile(filePath: string, mediaType: string): Promise<string> {
  const dir = imageAttachmentCacheDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${randomUUID()}.${IMAGE_EXTENSIONS[mediaType] ?? "img"}`);
  await copyFile(filePath, target);
  return target;
}

async function attachmentToImageBlock(attachment: FrontendAttachment): Promise<ContentBlock | null> {
  const mediaTypeHint = attachment.media_type ?? attachment.mime_type ?? null;
  if (attachment.data) {
    const { mediaType, data } = splitDataUri(attachment.data, mediaTypeHint ?? "image/jpeg");
    assertSupportedImage(mediaType);
    const buffer = Buffer.from(data, "base64");
    assertImageSize(buffer.byteLength);
    const path = await cacheImageBuffer(buffer, mediaType);
    return {
      type: "image",
      source: { type: "file", mediaType, path, sizeBytes: buffer.byteLength },
    };
  }

  if (!attachment.path) return null;
  const filePath = resolveToolPath(attachment.path, process.cwd());
  const mediaType = mediaTypeForPath(filePath, mediaTypeHint);
  assertSupportedImage(mediaType);
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Image attachment is not a file: ${filePath}`);
  }
  assertImageSize(info.size);
  const path = await cacheImageFile(filePath, mediaType);
  return {
    type: "image",
    source: {
      type: "file",
      mediaType,
      path,
      sizeBytes: info.size,
    },
  };
}

export async function buildUserContentWithAttachments(
  line: string,
  attachments?: FrontendAttachment[] | null,
): Promise<string | ContentBlock[]> {
  if (!attachments?.length) return line;

  const blocks: ContentBlock[] = [];
  if (line.trim()) blocks.push({ type: "text", text: line });

  let imageCount = 0;
  const imageLimit = maxImageAttachments();
  for (const attachment of attachments) {
    if ((attachment.type ?? "image") !== "image") continue;
    imageCount += 1;
    if (imageCount > imageLimit) {
      throw new Error(`Too many image attachments (max ${imageLimit}).`);
    }
    const block = await attachmentToImageBlock(attachment);
    if (block) blocks.push(block);
  }

  return blocks.length > 0 ? blocks : line;
}

export type MainEntryMode = "dry-run" | "tui" | "print";

/** Pure entry routing for tests and mainAction. */
export function resolveMainEntryMode(
  prompt: string | undefined,
  options: Pick<MainOptions, "dryRun" | "tui" | "print">,
): MainEntryMode {
  if (options.dryRun) return "dry-run";
  if (options.tui) return "tui";
  if (options.print && prompt) return "print";
  if (prompt) return "print";
  return "tui";
}

function isCoordinatorSessionRequested(options: Pick<MainOptions, "coordinator">): boolean {
  return options.coordinator === true || isCoordinatorMode();
}

/**
 * 应用程序的主入口点，根据提供的选项和提示决定执行模式。
 *
 * 模式优先级：
 * 1. dry-run
 * 2. TUI（`--tui` 或默认无 prompt）— 启动/attach daemon，再 spawn opentui 前端
 * 3. print（`-p` 或存在 prompt）— ensure daemon + Session API headless client
 */
export async function mainAction(
  prompt: string | undefined,
  options: MainOptions,
): Promise<void> {
  if (options.cwd) {
    process.chdir(options.cwd);
  }

  const overrides: Partial<Settings> = {};
  if (options.model) overrides.model = options.model;
  if (options.apiFormat) overrides.apiFormat = options.apiFormat as Settings["apiFormat"];
  if (options.permissionMode) overrides.permission = { mode: options.permissionMode as Settings["permission"]["mode"] };
  if (options.maxTurns) overrides.maxTurns = options.maxTurns;
  if (options.plugins === false) overrides.plugins = { enabled: false };

  const settings = await loadSettings(overrides, { includeProject: true, projectRoot: process.cwd() });

  if (options.debug) {
    console.log("Settings:", JSON.stringify(settings, null, 2));
  }

  const mode = resolveMainEntryMode(prompt, options);

  if (mode === "dry-run") {
    const { runDryRun } = await import("../dry-run");
    await runDryRun(settings, options);
    return;
  }

  if (mode === "print") {
    await runPrintMode(settings, prompt!, options);
    return;
  }

  await runTuiMode(settings, options, prompt);
}

/**
 * 用户 headless print：ensure daemon + Session API（见 `print-session.ts`）。
 */
async function runPrintMode(
  settings: Settings,
  prompt: string,
  options: MainOptions,
): Promise<void> {
  const { runPrintSession } = await import("../print-session.js");
  const path = await import("node:path");
  await runPrintSession(settings, prompt, {
    model: options.model ?? settings.model,
    cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
    verbose: options.verbose,
    outputFormat: options.outputFormat,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    permissionMode: options.permissionMode,
    coordinator: options.coordinator,
    maxTurns: options.maxTurns ?? settings.maxTurns,
    systemPrompt: options.systemPrompt,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    effort: options.effort,
    pluginsEnabled: options.plugins === false ? false : settings.plugins?.enabled,
    daemonUrl: options.daemonUrl,
    daemonToken: options.daemonToken,
  });
}

/**
 * 启动 TUI (Terminal User Interface) 模式。
 *
 * 本进程仅作**启动器**（默认 `ohs` 与显式 `ohs --tui`）：spawn opentui 前端（Bun 运行时）子进程，经
 * `OPENHARNESS_FRONTEND_CONFIG` 传入 daemon attach 信息。
 * 前端通过 `useServerSync` 与 daemon 通信。
 * 本进程 stdio inherit 终端给 opentui，等前端退出后 process.exit。详见 docs/tui-flow.md。
 *
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，用于启动/attach daemon 并传给前端
 * @param prompt - 可选的初始提示词，写入 frontendConfig.initial_prompt
 * @returns Promise<void>
 */
async function runTuiMode(
  settings: Settings,
  options: MainOptions,
  prompt?: string,
): Promise<void> {
  const bun = resolveBun();
  if (!bun) {
    console.error(
      "openharness TUI 需要 Bun 运行时（opentui 原生渲染器）。\n" +
      "安装：https://bun.sh — Windows: powershell -c \"irm bun.sh/install.ps1 | iex\"\n" +
      "或使用 -p/--print 模式无 TUI 运行。",
    );
    process.exit(1);
  }

  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const url = await import("node:url");
  const { ensureLocalDaemon } = await import("../ensure-daemon.js");
  let daemon: { url: string; token: string };
  if (options.daemonUrl) {
    const remoteUrl = options.daemonUrl.replace(/\/+$/, "");
    const parsed = new URL(remoteUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("--daemon-url must use http or https");
    }
    if (!options.daemonToken) throw new Error("--daemon-token is required with --daemon-url");
    daemon = { url: remoteUrl, token: options.daemonToken };
  } else {
    daemon = await ensureLocalDaemon();
  }

  const frontendConfig = JSON.stringify({
    daemon: {
      url: daemon.url,
      token: daemon.token,
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      model: options.model ?? settings.model,
      permissionMode: options.permissionMode ?? settings.permission.mode,
      maxTurns: options.maxTurns ?? settings.maxTurns,
      sessionMode: isCoordinatorSessionRequested(options) ? "coordinator" : null,
      pluginsEnabled: options.plugins === false ? false : settings.plugins?.enabled,
    },
    initial_prompt: prompt ?? null,
    theme: options.theme ?? "default",
    version: VERSION,
  });

  const cliDir = path.dirname(url.fileURLToPath(import.meta.url));
  let root = cliDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(root, "apps"))) break;
    root = path.dirname(root);
  }
  const bundledFrontendPath = path.join(cliDir, "frontend", "index.js");
  const repoFrontendPath = path.join(root, "apps", "frontend", "dist", "index.js");
  const frontendDistPath = existsSync(bundledFrontendPath) ? bundledFrontendPath : repoFrontendPath;
  if (!existsSync(frontendDistPath)) {
    throw new Error(`TUI frontend bundle not found: ${frontendDistPath}`);
  }

  // 启动 TUI 前清空当前终端（含滚动历史），让 Ink 界面从干净屏幕开始渲染。
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }

  const child = spawn(bun, [frontendDistPath], {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      OPENHARNESS_FRONTEND_CONFIG: frontendConfig,
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

/**
 * 三源加载技能到给定 registry：bundled（最先）→ user（getSkillsDir）→
 * project（cwd/.agents/skills + cwd/.openharness-ts/skills）。
 * register 是覆盖语义，
 * 同名后者覆盖前者，故顺序即优先级：bundled < user < project。
 * 1. 创建 SkillRegistry 实例
       ↓
 * 2. 调用 registerBundled() 加载内置技能
       ↓
 * 3. 创建 SkillLoader(registry)
       ↓
 * 4. 调用 loadFromDirectory("/path/to/skills")
       ↓
 * 5. 对每个 .md 文件：
       ├─ readFile() 读取内容
       ├─ parseSkillMarkdown() 解析元数据
       ├─ 构建 SkillDefinition 对象
       └─ registry.register() 注册到内存
       ↓
  * 6. 通过 registry.get(name) 查询和使用技能
 */
export async function loadSkillsThreeSources(
  skillRegistry: SkillRegistry,
  cwd: string,
  settings?: Settings,
) {
  skillRegistry.registerBundled();
  const pluginContributions: { plugins: Awaited<ReturnType<typeof loadNativePlugin>>[]; warnings: string[] } = { plugins: [], warnings: [] };
  if (settings && (settings.plugins?.enabled ?? true)) {
    const records = await discoverInstalledNativePlugins({ cwd });
    for (const record of records) {
      const verification = await verifyInstalledNativePlugin(record);
      if (verification.status !== "valid") {
        pluginContributions.warnings.push(...verification.diagnostics.map((item) => `${record.id}: ${item.message}`));
        continue;
      }
      const loaded = await loadNativePlugin(verification.plugin);
      pluginContributions.plugins.push(loaded);
      pluginContributions.warnings.push(...loaded.diagnostics.map((item) => item.message));
      for (const skill of loaded.components.skills?.value ?? []) skillRegistry.register(skill);
    }
  }
  // 插件贡献插在 bundled 之后、user/project 之前：bundled < plugin < user < project
  // （register 覆盖语义）。信任门控告警直接打到 stderr，三模式一致。
  for (const warning of pluginContributions.warnings) {
    process.stderr.write(`[plugins] ${warning}\n`);
  }
  const loader = new SkillLoader(skillRegistry);
  await loader.loadFromDirectory(getSkillsDir(), { source: "user", recursive: true });
  // 从 cwd 向上遍历到 git-root，收集所有层级的 project skill 目录（低优先→高优先）。
  const projectSkillDirs = await findProjectSkillDirs(cwd);
  for (const dir of projectSkillDirs) {
    await loader.loadFromDirectory(dir, { source: "project", recursive: true });
  }
  return pluginContributions;
}

/**
 * 判断输入 `/<word> [args]` 是否命中一个 user-invocable 的技能，命中则返回
 * {skill, args}（args 为去掉命令名后的剩余串），否则返回 null。
 *
 * 规则（内置命令优先）：
 * - 先解析 cmdName=`/<word>`、word=去掉前导 `/`。
 * - 若 cmdName 是内置命令（isBuiltinCommand 为 true）→ 返回 null（内置优先，
 *   不被 skill 覆盖，如 /help）。
 * - 否则按 word 命中 skill（精确名 / 小写 / 首字母大写 / commandName）且该 skill
 *   userInvocable → 返回 {skill, args}；否则 null。
 */
export function matchUserInvocableSkill(
  input: string,
  skillRegistry: SkillRegistry,
  isBuiltinCommand: (name: string) => boolean,
): { skill: SkillDefinition; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const cmdName = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  const args = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";
  const word = cmdName.slice(1);
  if (!word) return null;

  // 内置命令优先：不被 skill 覆盖。
  if (isBuiltinCommand(cmdName)) return null;

  // 按名解析 skill（对齐 Skill 工具的容错取法），并匹配 commandName。
  const skill = skillRegistry.resolve(word);
  if (!skill || !skill.userInvocable) return null;

  return { skill, args };
}

/**
 * 把一个 user-invocable 技能构造成一次注入引擎的 prompt：skill.content
 * 为主体，args 非空时在末尾追加一段 `## Arguments`。
 */
export function buildSkillPrompt(skill: SkillDefinition, args: string): string {
  const base = skill.content;
  const trimmedArgs = args.trim();
  if (!trimmedArgs) return base;
  return `${base.trimEnd()}\n\n## Arguments\n${trimmedArgs}\n`;
}

/**
 * 构建发给前端的斜杠命令列表。命令注册名本身已带前导 "/"（如 "/help"），
 * 因此不要再额外加 "/"（否则会出现 "//help" 双斜杠 bug）。
 *
 * 若传入 skillRegistry，则追加 user-invocable 技能的 `/<name>`（去重，内置命令
 * 名优先：与已有命令同名的 skill 不重复加入）。注意命令列表是给用户看的，
 * user-invocable 即可出现，即使 disableModelInvocation（那只挡模型不挡用户）。
 */
export function buildSlashCommandList(
  registry: CommandRegistry,
  skillRegistry?: SkillRegistry,
): string[] {
  const names = registry.list().map((c) => c.name);
  if (!skillRegistry) return names;

  const seen = new Set(names);
  for (const skill of skillRegistry.getAll()) {
    if (!skill.userInvocable) continue;
    const cmd = `/${skill.commandName ?? skill.name}`;
    if (seen.has(cmd)) continue; // 内置命令名优先，不重复
    seen.add(cmd);
    names.push(cmd);
  }
  return names;
}

/**
 * 构建发给前端的斜杠命令明细（名称 + 描述），供补全浮窗 / 命令面板展示。
 * 命名与去重规则同 {@link buildSlashCommandList}：内置命令优先，追加 user-invocable 技能。
 */
export function buildSlashCommandDetails(
  registry: CommandRegistry,
  skillRegistry?: SkillRegistry,
): Array<{ name: string; description: string }> {
  const details = registry.list().map((c) => ({ name: c.name, description: c.description ?? "" }));
  if (!skillRegistry) return details;

  const seen = new Set(details.map((d) => d.name));
  for (const skill of skillRegistry.getAll()) {
    if (!skill.userInvocable) continue;
    const cmd = `/${skill.commandName ?? skill.name}`;
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    details.push({ name: cmd, description: skill.description ?? "" });
  }
  return details;
}
