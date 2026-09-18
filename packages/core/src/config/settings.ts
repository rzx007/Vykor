import { readFile, mkdir } from "node:fs/promises";
import type { Settings } from "../index";
import { getConfigDir, getConfigFilePath, getProjectConfigDir, getProjectSettingsFilePath } from "./paths";
import { writeJsonFileAtomically } from "./atomic-json-write.js";

const DEFAULT_SETTINGS: Settings = {
  model: "minimax/minimax-m2.5:free",
  apiFormat: "openai",
  provider: "openrouter",
  maxTokens: 16384,
  maxTurns: 50,
  permission: { mode: "default" },
  plugins: { enabled: true },
  memory: {
    enabled: true,
    maxFiles: 5,
    maxEntrypointLines: 200,
    sessionMemoryEnabled: true,
    autoExtractEnabled: true,
    autoDreamEnabled: false,
    autoDreamMinHours: 24,
    autoDreamMinSessions: 5,
  },
  sandbox: {
    enabled: false,
    failIfUnavailable: false,
    filesystem: {
      allowRead: ["."],
      denyRead: [],
      allowWrite: ["."],
      denyWrite: [],
      extraAllowedRoots: [],
    },
    network: {
      mode: "none",
      allowedDomains: [],
      deniedDomains: [],
      strictDomainPolicy: false,
    },
    srt: {
      runtimeCommand: "srt",
    },
  },
  agentEnvironment: { kind: "native" },
  terminal: {},
  daemon: {
    autoStart: false,
  },
  effort: "medium",
  passes: 1,
  outputStyle: "default",
  workStyle: "practical",
};

type SettingsPatch = Partial<Omit<Settings, "sandbox" | "terminal" | "daemon" | "plugins">> & {
  sandbox?: Partial<NonNullable<Settings["sandbox"]>>;
  terminal?: Partial<NonNullable<Settings["terminal"]>>;
  daemon?: Partial<NonNullable<Settings["daemon"]>>;
  plugins?: Partial<NonNullable<Settings["plugins"]>>;
};

/**
 * 加载并合并配置设置。
 *
 * 按照以下优先级顺序合并配置（后者覆盖前者）：
 * 1. 默认设置 (DEFAULT_SETTINGS)
 * 2. 文件配置 (loadFromFile)
 * 3. 环境变量配置 (loadFromEnv)
 * 4. CLI 覆盖参数 (cliOverrides)
 *
 * @param cliOverrides - 可选的命令行参数覆盖项，用于部分覆盖最终生成的设置
 * @returns 合并后的完整 Settings 对象
 */
export async function loadSettings(
  cliOverrides?: Partial<Settings>,
  options: { projectRoot?: string; includeProject?: boolean } = {},
): Promise<Settings> {
  // 从环境变量加载配置
  const envSettings = loadFromEnv();
  // 从配置文件异步加载配置
  const fileSettings = await loadFromFile();
  const projectSettings = options.includeProject
    ? await loadProjectSettings(options.projectRoot)
    : null;

  // 按优先级合并所有配置源
  const merged = {
    ...DEFAULT_SETTINGS,
    ...fileSettings,
    ...projectSettings,
    ...envSettings,
    ...cliOverrides,
  } as Settings;
  merged.memory = {
    ...DEFAULT_SETTINGS.memory,
    ...fileSettings?.memory,
    ...projectSettings?.memory,
    ...envSettings.memory,
    ...cliOverrides?.memory,
    enabled: cliOverrides?.memory?.enabled
      ?? envSettings.memory?.enabled
      ?? projectSettings?.memory?.enabled
      ?? fileSettings?.memory?.enabled
      ?? DEFAULT_SETTINGS.memory?.enabled
      ?? true,
  };
  merged.sandbox = mergeSandboxConfig(
    DEFAULT_SETTINGS.sandbox,
    fileSettings?.sandbox,
    projectSettings?.sandbox,
    envSettings.sandbox,
    cliOverrides?.sandbox,
  );
  merged.agentEnvironment = {
    ...DEFAULT_SETTINGS.agentEnvironment,
    ...fileSettings?.agentEnvironment,
    ...envSettings.agentEnvironment,
    ...cliOverrides?.agentEnvironment,
  } as NonNullable<Settings["agentEnvironment"]>;
  merged.terminal = {
    ...DEFAULT_SETTINGS.terminal,
    ...fileSettings?.terminal,
    ...projectSettings?.terminal,
    ...envSettings.terminal,
    ...cliOverrides?.terminal,
  };
  merged.daemon = {
    ...DEFAULT_SETTINGS.daemon,
    ...fileSettings?.daemon,
    ...envSettings.daemon,
    ...cliOverrides?.daemon,
  } as NonNullable<Settings["daemon"]>;
  merged.plugins = {
    ...DEFAULT_SETTINGS.plugins,
    ...fileSettings?.plugins,
    ...projectSettings?.plugins,
    ...envSettings.plugins,
    ...cliOverrides?.plugins,
  } as NonNullable<Settings["plugins"]>;
  merged.customProviders = fileSettings?.customProviders;
  return merged;
}

/**
 * 将设置对象保存为 JSON 文件到用户主目录下的 .openharness-ts 配置文件夹中。
 *
 * @param settings - 要保存的设置对象，将被序列化为格式化的 JSON 字符串。
 * @returns 无返回值（Promise<void>），表示保存操作完成。
 */
export async function saveSettings(settings: Settings): Promise<void> {
  // 构建配置目录和文件路径
  const configDir = getConfigDir();
  const configPath = getConfigFilePath();

  // 确保配置目录存在，若不存在则递归创建
  await mkdir(configDir, { recursive: true });

  await writeJsonFileAtomically(configPath, settings);
}

export async function loadProjectSettings(projectRoot?: string): Promise<Partial<Settings> | null> {
  return loadSettingsFile(getProjectSettingsFilePath(projectRoot));
}

export async function saveProjectSettings(
  settings: Partial<Settings>,
  projectRoot?: string,
): Promise<void> {
  const configDir = getProjectConfigDir(projectRoot);
  const configPath = getProjectSettingsFilePath(projectRoot);
  await mkdir(configDir, { recursive: true });
  await writeJsonFileAtomically(configPath, settings);
}

function loadFromEnv(): SettingsPatch {
  const result: SettingsPatch = {};
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  if (apiKey !== undefined) result.apiKey = apiKey;
  if (process.env.ANTHROPIC_MODEL !== undefined) result.model = process.env.ANTHROPIC_MODEL;
  if (process.env.OPENHARNESS_MODEL !== undefined) result.model = process.env.OPENHARNESS_MODEL;
  if (process.env.OPENHARNESS_API_FORMAT !== undefined) result.apiFormat = process.env.OPENHARNESS_API_FORMAT as Settings["apiFormat"];
  // 通用 baseUrl 只认 OPENHARNESS_BASE_URL。不要用 ANTHROPIC_BASE_URL ——
  // 它是 Anthropic 专属（很多人为 Claude Code 设了 ANTHROPIC_BASE_URL=api.anthropic.com），
  // 灌进通用 baseUrl 会污染非 Anthropic provider（如 deepseek 的请求被发到 anthropic 端点）。
  // anthropic provider 的 baseURL 由 Anthropic SDK 自行读取 ANTHROPIC_BASE_URL。
  if (process.env.OPENHARNESS_BASE_URL !== undefined) {
    result.baseUrl = process.env.OPENHARNESS_BASE_URL;
  }
  if (process.env.OPENHARNESS_MAX_TOKENS !== undefined) result.maxTokens = parseInt(process.env.OPENHARNESS_MAX_TOKENS, 10);
  if (process.env.OPENHARNESS_MAX_TURNS !== undefined) result.maxTurns = parseInt(process.env.OPENHARNESS_MAX_TURNS, 10);
  const sandbox = buildSandboxEnvOverrides();
  if (sandbox !== undefined) result.sandbox = sandbox;
  if (process.env.OPENHARNESS_AGENT_ENVIRONMENT === "native" || process.env.OPENHARNESS_AGENT_ENVIRONMENT === "wsl") {
    result.agentEnvironment = { kind: process.env.OPENHARNESS_AGENT_ENVIRONMENT };
  }

  return result;
}

function buildSandboxEnvOverrides(): Partial<NonNullable<Settings["sandbox"]>> | undefined {
  const sandbox: Partial<NonNullable<Settings["sandbox"]>> = {};
  if (process.env.OPENHARNESS_SANDBOX_ENABLED !== undefined) {
    sandbox.enabled = parseBooleanEnv(process.env.OPENHARNESS_SANDBOX_ENABLED);
  }
  if (process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE !== undefined) {
    sandbox.failIfUnavailable = parseBooleanEnv(
      process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE,
    );
  }
  if (process.env.OPENHARNESS_SANDBOX_NETWORK_MODE !== undefined) {
    const mode = process.env.OPENHARNESS_SANDBOX_NETWORK_MODE;
    if (mode === "none" || mode === "bridge" || mode === "host" || mode === "proxy") {
      sandbox.network = { mode };
    }
  }
  return Object.keys(sandbox).length > 0 ? sandbox : undefined;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function mergeSandboxConfig(
  ...configs: Array<Partial<NonNullable<Settings["sandbox"]>> | undefined | null>
): Settings["sandbox"] {
  const result: NonNullable<Settings["sandbox"]> = { enabled: false };
  for (const config of configs) {
    if (!config) continue;
    const filesystem = result.filesystem;
    const network = result.network;
    const srt = result.srt;
    Object.assign(result, config);
    result.filesystem = { ...filesystem, ...config.filesystem };
    result.network = { ...network, ...config.network };
    result.srt = { ...srt, ...config.srt };
  }
  return result;
}

/**
 * 从用户主目录下的配置文件中加载设置信息。
 * 
 * 该函数尝试读取位于 `~/.openharness-ts/settings.json` 的配置文件。
 * 如果文件存在且内容合法，则解析并返回部分设置对象；
 * 如果文件不存在、无法访问或解析失败，则返回 null。
 * 
 * @returns {Promise<Partial<Settings> | null>} 解析后的部分设置对象，若加载失败则返回 null
 */
async function loadFromFile(): Promise<Partial<Settings> | null> {
  // 构建配置文件的完整路径
  const configPath = getConfigFilePath();
  return loadSettingsFile(configPath);
}

async function loadSettingsFile(configPath: string): Promise<Partial<Settings> | null> {
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Settings file must contain a JSON object: ${configPath}`);
    }
    const settings = parsed as Record<string, unknown>;
    validateSettingsFields(settings, configPath);
    stripLegacyFeishuSecretFields(settings);
    return settings as Partial<Settings>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class SettingsFileError extends Error {
  readonly code = "invalid_settings_field";

  constructor(
    readonly field: string,
    readonly path: string,
  ) {
    super(`Unknown or deprecated settings field ${field} in ${path}`);
    this.name = "SettingsFileError";
  }
}

const TOP_LEVEL_SETTINGS_FIELDS = new Set([
  "apiKey",
  "model",
  "apiFormat",
  "maxTokens",
  "baseUrl",
  "provider",
  "customProviders",
  "maxTurns",
  "systemPrompt",
  "permission",
  "hooks",
  "memory",
  "sandbox",
  "agentEnvironment",
  "terminal",
  "mcpServers",
  "plugins",
  "channels",
  "daemon",
  "theme",
  "outputStyle",
  "workStyle",
  "fastMode",
  "effort",
  "passes",
  "childBudget",
  "verbose",
]);

function validateSettingsFields(
  settings: Record<string, unknown>,
  configPath: string,
): void {
  assertKnownFields(settings, TOP_LEVEL_SETTINGS_FIELDS, "settings", configPath);
  assertNestedFields(settings, "permission", [
    "mode",
    "allowedTools",
    "deniedTools",
    "pathRules",
    "deniedCommands",
    "autoApproveTools",
  ], configPath);
  assertNestedFields(settings, "memory", [
    "enabled",
    "maxFiles",
    "maxEntrypointLines",
    "sessionMemoryEnabled",
    "autoExtractEnabled",
    "autoDreamEnabled",
    "autoDreamMinHours",
    "autoDreamMinSessions",
  ], configPath);
  assertNestedFields(settings, "sandbox", [
    "enabled",
    "failIfUnavailable",
    "enabledPlatforms",
    "filesystem",
    "network",
    "srt",
  ], configPath);
  assertNestedFields(settings, "agentEnvironment", ["kind"], configPath);
  const sandbox = recordValue(settings.sandbox);
  if (sandbox) {
    assertNestedFields(sandbox, "filesystem", [
      "allowRead",
      "denyRead",
      "allowWrite",
      "denyWrite",
      "extraAllowedRoots",
    ], configPath, "settings.sandbox");
    assertNestedFields(sandbox, "network", [
      "mode",
      "allowedDomains",
      "deniedDomains",
      "strictDomainPolicy",
    ], configPath, "settings.sandbox");
    assertNestedFields(sandbox, "srt", ["runtimeCommand"], configPath, "settings.sandbox");
  }
  assertNestedFields(settings, "terminal", ["localShell"], configPath);
  assertNestedFields(settings, "plugins", ["enabled"], configPath);
  assertNestedFields(settings, "daemon", ["autoStart"], configPath);
  assertNestedFields(settings, "childBudget", [
    "maxDepth",
    "maxActiveChildren",
    "maxTotalChildren",
  ], configPath);
  assertNestedFields(settings, "channels", ["sendProgress", "sendToolHints", "feishu"], configPath);
  const channels = recordValue(settings.channels);
  if (channels) {
    assertNestedFields(channels, "feishu", [
      "enabled",
      "appId",
      "domain",
      "allowFrom",
      "replyAtBotNames",
      // 旧字段：接受但忽略，避免旧 settings.json 触发 SettingsFileError。
      "appSecret",
      "encryptKey",
      "verificationToken",
    ], configPath, "settings.channels");
  }
  const mcpServers = recordValue(settings.mcpServers);
  if (mcpServers) {
    for (const [name, rawServer] of Object.entries(mcpServers)) {
      const server = recordValue(rawServer);
      if (!server) continue;
      assertKnownFields(
        server,
        new Set(["type", "command", "args", "env", "cwd", "url", "headers", "oauth"]),
        `settings.mcpServers.${name}`,
        configPath,
      );
      assertNestedFields(
        server,
        "oauth",
        ["scopes", "clientId", "callbackPort"],
        configPath,
        `settings.mcpServers.${name}`,
      );
    }
  }
}

function assertNestedFields(
  owner: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  configPath: string,
  prefix = "settings",
): void {
  const value = owner[field];
  if (value === undefined) return;
  const record = recordValue(value);
  if (!record) return;
  assertKnownFields(record, new Set(allowed), `${prefix}.${field}`, configPath);
}

function assertKnownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  configPath: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new SettingsFileError(`${prefix}.${key}`, configPath);
    }
  }
}

const LEGACY_FEISHU_SECRET_FIELDS = ["appSecret", "encryptKey", "verificationToken"] as const;

/** 旧版 settings.json 把飞书密钥放在 channels.feishu；现在密钥只存凭据文件，加载时丢弃这些字段。 */
function stripLegacyFeishuSecretFields(settings: Record<string, unknown>): void {
  const channels = recordValue(settings.channels);
  const feishu = channels ? recordValue(channels.feishu) : undefined;
  if (!feishu) return;
  for (const field of LEGACY_FEISHU_SECRET_FIELDS) delete feishu[field];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
